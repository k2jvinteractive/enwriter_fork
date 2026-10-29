'use strict';
// Project snapshots (part 7e, main process only).
//
//   <book>.mwt/Snapshots/<id>/snapshot.json   { id, createdAt, label, kind, reason, counts{}, bytes, fingerprint }
//   <book>.mwt/Snapshots/<id>/book.json       the book's index at that moment
//   <book>.mwt/Snapshots/<id>/Files/          every body file, darling payload and thumbnail
//   <book>.mwt/Snapshots/.removed/<id>/       deleted snapshots, kept a week so Undo works, then sent to the OS trash
//   <book>.mwt/.restore/                      only while a restore is running (see "restoring" below)
//
// Snapshots never go inside book.json or the store's undo history. The renderer only sends ids and short
// strings; every path is built here from the open book's folder.

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const ID_RE = /^[\w-]+$/;
const REASON_RE = /^[a-z][a-z-]{0,30}$/;
const MAX_AUTO = 30;
const REMOVED_DAYS = 7;
const LABEL_MAX = 120;
const SNAP = 'Snapshots';
const REMOVED = '.removed';
const COUNT_KEYS = ['chapters', 'scenes', 'words', 'characters', 'places', 'notes', 'tags', 'plotlines'];

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const readJson = async (file) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
const rmQuiet = (p) => fs.rm(p, { recursive: true, force: true }).catch(() => {});
const cleanLabel = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) : '');

// Counts for a snapshot card, read from a book.json. Words are the sum of the scenes; saves from before
// chapters had scenes kept them on the chapter (same rule as scanBooks in library.js).
function countsOf(book) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const c = { chapters: 0, scenes: 0, words: 0, characters: arr(book && book.characters).length, places: arr(book && book.places).length,
    notes: arr(book && book.notes).length, tags: arr(book && book.tags).length, plotlines: arr(book && book.plotlines).length };
  for (const ch of arr(book && book.chapters)) {
    c.chapters++;
    const scenes = arr(ch && ch.scenes);
    if (scenes.length) { for (const s of scenes) { c.scenes++; c.words += Number(s && s.words) || 0; } }
    else c.words += Number(ch && ch.words) || 0;
  }
  return c;
}

// Everything a snapshot holds, listed with sizes. Dot files and half-written temp files are not part of a book.
async function listParts(dir) {
  const out = [];
  const walk = async (d, rel) => {
    let ents = [];
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue;
      if (e.isFile()) out.push({ rel: rel + e.name, file: path.join(d, e.name) });
    }
  };
  await walk(path.join(dir, 'Files'), 'Files/');
  return out;
}

// A hash of book.json plus the content of every body file. (Content, not modification times: a restore or
// a copy changes times without changing the book, and this way "nothing changed" is exactly true.)
// Files are read one at a time so the main process stays responsive.
async function fingerprint(dir) {
  const h = crypto.createHash('sha1');
  let bytes = 0;
  let book;
  try { book = await fs.readFile(path.join(dir, 'book.json')); } catch { book = Buffer.alloc(0); }
  h.update('book.json\0').update(book);
  bytes += book.length;
  for (const p of await listParts(dir)) {
    let buf;
    try { buf = await fs.readFile(p.file); } catch { continue; }   // removed while we were reading: the next check sees it
    h.update('\0' + p.rel + '\0').update(buf);
    bytes += buf.length;
  }
  return { hash: h.digest('hex'), bytes };
}

function create({ getDir, shell, writeAtomic, checkVersion }) {
  const snapRoot = () => path.join(getDir(), SNAP);
  const snapDir = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid snapshot id');
    return path.join(snapRoot(), id);
  };
  const removedRoot = () => path.join(snapRoot(), REMOVED);

  // One snapshot operation at a time per process: create, restore, remove and rename all touch the same folders.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.catch(() => {}).then(fn);
    chain = run;
    return run;
  };

  // While a restore swaps files, writes from the renderer are dropped (resolve false) instead of landing in the
  // middle of the swap. The renderer also stops its own autosave first; this is the second lock.
  let restoring = false;

  async function readMeta(dir) {
    const m = await readJson(path.join(dir, 'snapshot.json'));
    if (!m || typeof m.id !== 'string' || !ID_RE.test(m.id) || !Number.isFinite(m.createdAt)) return null;
    return {
      id: m.id,
      createdAt: m.createdAt,
      label: cleanLabel(m.label) || 'Snapshot',
      kind: m.kind === 'auto' ? 'auto' : 'manual',
      reason: typeof m.reason === 'string' && REASON_RE.test(m.reason) ? m.reason : '',
      counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, Number(m.counts && m.counts[k]) || 0])),
      bytes: Number(m.bytes) || 0,
      fingerprint: typeof m.fingerprint === 'string' ? m.fingerprint : ''
    };
  }

  // Newest first. Folders without a readable snapshot.json (a crash while copying) are not listed.
  async function listAll() {
    const items = [];
    let ents = [];
    try { ents = await fs.readdir(snapRoot(), { withFileTypes: true }); } catch { return items; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || !ID_RE.test(e.name)) continue;
      const m = await readMeta(path.join(snapRoot(), e.name));
      if (m && m.id === e.name) items.push(m);
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items;
  }

  // Moves a snapshot folder to .removed (it can be brought back for a week).
  async function moveToRemoved(id) {
    const from = snapDir(id);
    if (!(await exists(from))) return false;
    await fs.mkdir(removedRoot(), { recursive: true });
    const to = path.join(removedRoot(), id);
    await rmQuiet(to);
    await fs.rename(from, to);
    const m = await readJson(path.join(to, 'snapshot.json'));
    if (m) { m.removedAt = Date.now(); try { await writeAtomic(path.join(to, 'snapshot.json'), JSON.stringify(m, null, 2)); } catch { /* the folder's age is used instead */ } }
    return true;
  }

  // At most MAX_AUTO automatic snapshots; the oldest go to .removed like any deleted snapshot. Manual ones are never touched.
  async function pruneAuto(keep) {
    const autos = (await listAll()).filter((s) => s.kind === 'auto');
    for (const s of autos.slice(MAX_AUTO)) { if (s.id === keep) continue; try { await moveToRemoved(s.id); } catch { /* try again next time */ } }
  }

  // ---- create -----------------------------------------------------------------------------------
  // Copies the open book into a new snapshot. Not queued itself: callers hold the turn (createSnapshot, restoreSnapshot).
  async function copyBook(opts, keep) {
    const dir = getDir();
    const kind = opts.kind === 'auto' ? 'auto' : 'manual';
    const id = crypto.randomUUID();
    const root = snapRoot();
    const tmp = path.join(root, '.tmp-' + id);
    await fs.mkdir(root, { recursive: true });
    try {
      await fs.mkdir(path.join(tmp, 'Files'), { recursive: true });
      for (const p of await listParts(dir)) await fs.copyFile(p.file, path.join(tmp, p.rel)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
      await fs.copyFile(path.join(dir, 'book.json'), path.join(tmp, 'book.json'));
      const copy = await fingerprint(tmp);
      const book = await readJson(path.join(tmp, 'book.json'));
      const meta = { id, createdAt: Date.now(), label: cleanLabel(opts.label) || (kind === 'auto' ? 'Automatic snapshot' : 'Snapshot'), kind,
        reason: REASON_RE.test(opts.reason || '') ? opts.reason : '', counts: countsOf(book), bytes: copy.bytes, fingerprint: copy.hash };
      await writeAtomic(path.join(tmp, 'snapshot.json'), JSON.stringify(meta, null, 2));
      await fs.rename(tmp, path.join(root, id));
      if (kind === 'auto') await pruneAuto(keep);
      return meta;
    } catch (err) { await rmQuiet(tmp); throw err; }
  }

  // opts: { label, kind: 'manual'|'auto', reason, force }. Unless `force`, nothing is created when the book is
  // identical to the newest snapshot; the answer is then { created: false, snapshot: <that snapshot> }.
  function createSnapshot(opts = {}) {
    return serial(async () => {
      if (!opts.force) {
        const now = await fingerprint(getDir());
        const newest = (await listAll())[0];
        if (newest && newest.fingerprint === now.hash) return { created: false, snapshot: newest };
      }
      return { created: true, snapshot: await copyBook(opts) };
    });
  }

  // ---- restore ----------------------------------------------------------------------------------
  // The swap replaces book.json and Files/. It is done in a way that survives a crash at any point:
  //   1. copy the snapshot into <book>/.restore/staging and check it             (crash: staging is thrown away)
  //   2. write <book>/.restore/pending.json                                       (from here on, the swap is finished, never undone)
  //   3. move the current Files/ and book.json into .restore/old, then move the staged ones in
  //   4. delete .restore
  // recover() runs when a book is opened and completes step 3 and 4 if the app died in the middle of them.
  const SWAP = ['Files', 'book.json'];

  async function finishSwap(dir) {
    const R = path.join(dir, '.restore');
    const staging = path.join(R, 'staging');
    const old = path.join(R, 'old');
    await fs.mkdir(old, { recursive: true });
    for (const name of SWAP) {
      const s = path.join(staging, name), cur = path.join(dir, name), o = path.join(old, name);
      if (!(await exists(s))) continue;   // already moved in
      if (await exists(cur)) {
        if (!(await exists(o))) await fs.rename(cur, o);
        else await rmQuiet(cur);          // cannot happen in order; never leave two copies in the way
      }
      await fs.rename(s, cur);
    }
    await rmQuiet(R);
  }

  async function recover(dir) {
    const R = path.join(dir, '.restore');
    if (!(await exists(R))) return false;
    if (await exists(path.join(R, 'pending.json'))) { await finishSwap(dir); return true; }
    await rmQuiet(R);   // crashed while staging: the book was never touched
    return false;
  }

  async function copyDir(from, to) {
    await fs.cp(from, to, { recursive: true, errorOnExist: true, preserveTimestamps: true });
  }

  function restoreSnapshot(id) {
    return serial(async () => {
      const dir = getDir();
      const from = snapDir(id);
      const meta = await readMeta(from);
      const book = await readJson(path.join(from, 'book.json'));
      if (!meta || !book || !(await exists(path.join(from, 'Files')))) throw new Error('That snapshot is damaged or missing. Nothing was changed.');
      checkVersion(book, 'That snapshot');

      // The way back. If the book is already identical to the newest snapshot, that snapshot is the way back.
      const now = await fingerprint(dir);
      const newest = (await listAll())[0];
      const safe = newest && newest.fingerprint === now.hash
        ? newest
        : await copyBook({ kind: 'auto', reason: 'before-restore', label: 'Before restore' }, id);   // `id` must survive the pruning that follows

      const R = path.join(dir, '.restore');
      const staging = path.join(R, 'staging');
      try {
        await rmQuiet(R);
        await fs.mkdir(staging, { recursive: true });
        await copyDir(path.join(from, 'Files'), path.join(staging, 'Files'));
        await fs.copyFile(path.join(from, 'book.json'), path.join(staging, 'book.json'));
        const check = await fingerprint(staging);
        if (check.hash !== meta.fingerprint) throw new Error('The copy of that snapshot did not check out. Nothing was changed.');
      } catch (err) {
        await rmQuiet(R);
        // Nothing has been swapped yet: say so, the renderer relies on it to skip reloading the book.
        const why = err && err.message ? String(err.message) : 'it could not be copied';
        throw new Error(/Nothing was changed/.test(why) ? why : why.replace(/\.?$/, '') + '. Nothing was changed.');
      }
      restoring = true;
      try {
        await writeAtomic(path.join(R, 'pending.json'), JSON.stringify({ id, at: Date.now() }));
        await finishSwap(dir);
      } finally { restoring = false; }
      return { ok: true, undoId: safe.id };
    });
  }

  // ---- the rest ---------------------------------------------------------------------------------
  const rename = (id, label) => serial(async () => {
    const clean = cleanLabel(label);
    if (!clean) throw new Error('A snapshot needs a name');
    const file = path.join(snapDir(id), 'snapshot.json');
    const m = await readJson(file);
    if (!m) throw new Error('That snapshot no longer exists');
    m.label = clean;
    await writeAtomic(file, JSON.stringify(m, null, 2));
    return clean;
  });

  const remove = (id) => serial(async () => {
    if (!(await moveToRemoved(id))) throw new Error('That snapshot no longer exists');
    return true;
  });

  const restoreRemoved = (id) => serial(async () => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid snapshot id');
    const from = path.join(removedRoot(), id);
    if (!(await exists(from))) throw new Error('That snapshot is gone');
    const to = snapDir(id);
    await rmQuiet(to);
    await fs.rename(from, to);
    const m = await readJson(path.join(to, 'snapshot.json'));
    if (m && 'removedAt' in m) { delete m.removedAt; await writeAtomic(path.join(to, 'snapshot.json'), JSON.stringify(m, null, 2)); }
    return true;
  });

  // The titles and word counts inside a snapshot, so the writer can see what is in it before restoring.
  async function outline(id) {
    const book = await readJson(path.join(snapDir(id), 'book.json'));
    if (!book) throw new Error('That snapshot is damaged or missing.');
    const arr = (v) => (Array.isArray(v) ? v : []);
    const t = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
    return {
      title: t(book.title),
      chapters: arr(book.chapters).slice(0, 2000).map((ch) => {
        const scenes = arr(ch && ch.scenes).slice(0, 5000).map((s) => ({ title: t(s && s.title), words: Number(s && s.words) || 0 }));
        return { title: t(ch && ch.title), words: scenes.length ? scenes.reduce((n, s) => n + s.words, 0) : Number(ch && ch.words) || 0, scenes };
      })
    };
  }

  // Housekeeping for one book folder: leftover temp folders, and deleted snapshots older than a week go to the OS trash.
  async function sweep(dir) {
    const root = path.join(dir, SNAP);
    let ents = [];
    try { ents = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && e.name.startsWith('.tmp-')) await rmQuiet(path.join(root, e.name));
    const rroot = path.join(root, REMOVED);
    let gone = [];
    try { gone = await fs.readdir(rroot, { withFileTypes: true }); } catch { return; }
    const limit = Date.now() - REMOVED_DAYS * 24 * 3600 * 1000;
    for (const e of gone) {
      if (!e.isDirectory()) continue;
      const p = path.join(rroot, e.name);
      const m = await readJson(path.join(p, 'snapshot.json'));
      let when = m && Number(m.removedAt);
      if (!Number.isFinite(when)) { try { when = (await fs.stat(p)).mtimeMs; } catch { continue; } }
      if (when < limit) { try { await shell.trashItem(p); } catch { /* no trash available: it stays and is tried again */ } }
    }
  }

  function register(h) {
    const id = (v) => { if (typeof v !== 'string' || !ID_RE.test(v)) throw new Error('Invalid snapshot id'); return v; };
    h('snapshot:create', (opts) => createSnapshot(opts && typeof opts === 'object' ? opts : {}));
    h('snapshot:list', async () => { await sweep(getDir()); return listAll(); });
    h('snapshot:restore', (v) => restoreSnapshot(id(v)));
    h('snapshot:rename', (v, label) => rename(id(v), label));
    h('snapshot:remove', (v) => remove(id(v)));
    h('snapshot:restore-removed', (v) => restoreRemoved(id(v)));
    h('snapshot:outline', (v) => outline(id(v)));
  }

  return { register, recover, sweep, isRestoring: () => restoring };
}

module.exports = { create, countsOf, fingerprint, MAX_AUTO };
