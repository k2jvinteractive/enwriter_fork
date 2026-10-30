'use strict';
// Library and .mwt package storage (main process only).
//
//   <library>/library.json            { formatVersion, migrated, shelves[], bookMeta{} }
//   <library>/<Title>.mwt/book.json   today's index.json
//   <library>/<Title>.mwt/Files/      <id>.html, thumb-<id>, darling-<id>
//   <library>/<Title>.mwt/Meta/       info.json, optional cover.webp
//
// The renderer only ever sees book ids. Folder names and absolute paths stay in here, so a
// compromised renderer cannot point us at an arbitrary location.

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const snapshotsModule = require('./snapshots');
const privateShelfModule = require('./private-shelf');

const FORMAT_VERSION = 1;
const ID_RE = /^[\w-]+$/;
const EXT = '.mwt';

// Part 7c: spell check languages, as data so more can be added later. The renderer mirrors this list
// (emw.SPELL_LANGUAGES in settings.js); main is the one that checks it.
const SPELL_LANGUAGES = [
  { id: 'en-US', label: 'US English', short: 'US' },
  { id: 'en-GB', label: 'UK English', short: 'UK' }
];
const SPELL_IDS = SPELL_LANGUAGES.map((l) => l.id);

// Custom dictionary words: letters (any script, so accented names work), marks, apostrophes and
// hyphens. A curly apostrophe is stored straight, because smart quotes turn ' into ’ while typing
// and the checker treats both as the same letter.
const MAX_WORDS = 5000;
const MAX_WORD_LENGTH = 60;
const WORD_RE = /^[\p{L}\p{M}'-]+$/u;
const HAS_LETTER = /\p{L}/u;

// Returns a clean list from anything: drops what is not a valid word, de-duplicates ignoring case
// (first spelling wins), keeps the order and stops at the cap. Never throws.
function sanitiseWords(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set();
  for (const raw of list) {
    if (out.length >= MAX_WORDS) break;
    if (typeof raw !== 'string') continue;
    const w = raw.trim().replace(/\u2019/g, "'");
    if (w.length < 1 || w.length > MAX_WORD_LENGTH || !WORD_RE.test(w) || !HAS_LETTER.test(w)) continue;
    const key = w.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

function create({ app, dialog, shell, writeAtomic }) {
  // ---- settings.json -------------------------------------------------------------------------
  // Lives in userData, never in the library: the library's own location is a setting.
  // DEFAULTS is mirrored in renderer/settings.js; saved values are merged over it, so a setting
  // added in a later version appears automatically for people with an older file.
  const DEFAULTS = {
    libraryPath: null,
    lastBookId: null,
    penName: '',
    theme: 'dark',        // 'dark' | 'light' | 'system'
    accent: '#e8caa4',
    uiScale: 100,         // percent
    reduceMotion: null,   // null = follow the OS
    // Writing (part 5d)
    pageWidth: 'medium',  // 'narrow' | 'medium' | 'wide'
    writingFont: '',      // '' = the app's serif; applies to new text only
    writingSize: 18,
    writingSpacing: 1.75,
    smartQuotes: true,
    quoteStyle: 'en',     // 'en' | 'fr' | 'de'
    autoEllipsis: true,
    autoHighlight: false,
    typewriter: false,
    autosaveDelay: 600,   // ms
    // Bottom bar (part 5d). Ids not listed in `order` are appended by the renderer, so tabs
    // added in a later version show up on their own.
    tabs: { order: ['home', 'places', 'characters', 'timeline', 'manuscript', 'darlings', 'notes', 'tags'], hidden: [] },
    statsSide: 'right',   // 'left' | 'right'
    // Part 7a: only the writer's keyboard changes, { actionId: [bindings] }. An empty list means unbound.
    shortcuts: {},
    // Part 7b: off until the writer turns it on (ribbon button, F7). Applied to the whole session by main.js.
    spellcheck: false,
    // Part 7c: the default language (a book may override it in book.json) and the shared custom dictionary.
    spellLanguage: 'en-US',
    customWords: []
  };

  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
  let settings = null;
  // Part 7h: the private shelf's password hash. It lives in settings.json but is kept out of
  // `settings` and DEFAULTS, so settings:get, settings:get-sync and settings:set can never read or
  // write it. Only private-shelf.js (through saveSecret below) changes it.
  let secret = null;
  const serialise = (s) => JSON.stringify(secret ? { ...s, privateShelf: secret } : s, null, 2);
  // The folder the user last picked in the native dialog. settings:set only accepts a
  // libraryPath equal to this, so the renderer can never invent a path.
  let pickedFolder = null;

  // Same grammar as KEY_RE in renderer/shortcuts.js: modifiers in the order Ctrl+Alt+Shift, then one key.
  const KEY_RE = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(?:[A-Z0-9]|[,./;'[\]\\=`-]|Enter|Tab|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Escape|F(?:[1-9]|1[0-2]))$/;

  const SETTING_RULES = {
    libraryPath: (v) => v === null || (typeof v === 'string' && v === pickedFolder),
    lastBookId: (v) => v === null || (typeof v === 'string' && ID_RE.test(v)),
    penName: (v) => typeof v === 'string' && v.length <= 100,
    theme: (v) => ['dark', 'light', 'system'].includes(v),
    accent: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
    uiScale: (v) => [90, 100, 110, 125].includes(v),
    reduceMotion: (v) => v === null || typeof v === 'boolean',
    pageWidth: (v) => ['narrow', 'medium', 'wide'].includes(v),
    writingFont: (v) => typeof v === 'string' && v.length <= 100,
    writingSize: (v) => Number.isInteger(v) && v >= 8 && v <= 96,
    writingSpacing: (v) => [1, 1.15, 1.5, 1.75, 2, 2.5].includes(v),
    smartQuotes: (v) => typeof v === 'boolean',
    quoteStyle: (v) => ['en', 'fr', 'de'].includes(v),
    autoEllipsis: (v) => typeof v === 'boolean',
    autoHighlight: (v) => typeof v === 'boolean',
    typewriter: (v) => typeof v === 'boolean',
    autosaveDelay: (v) => Number.isInteger(v) && v >= 200 && v <= 2000,
    // Only the shape is checked here; the renderer decides which ids it knows. Short plain
    // ids keep a hand-edited file from smuggling anything odd into the DOM.
    tabs: (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      const ids = (a) => Array.isArray(a) && a.length <= 40 && a.every((x) => typeof x === 'string' && /^[a-z][a-z-]{0,30}$/.test(x));
      return ids(v.order) && ids(v.hidden);
    },
    statsSide: (v) => v === 'left' || v === 'right',
    spellcheck: (v) => typeof v === 'boolean',
    spellLanguage: (v) => SPELL_IDS.includes(v),
    // Checked after SANITISERS has cleaned the list, so this only fails for something that is not a list.
    customWords: (v) => Array.isArray(v) && v.length <= MAX_WORDS && sanitiseWords(v).length === v.length,
    // Shape only; the renderer decides which action ids it knows (unknown ones are kept for later versions).
    shortcuts: (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      const ids = Object.keys(v);
      return ids.length <= 300 && ids.every((id) => id !== '__proto__' && /^[\w.-]{1,60}$/.test(id) && Array.isArray(v[id]) &&
        v[id].length <= 10 && v[id].every((b) => typeof b === 'string' && b.length <= 40 && KEY_RE.test(b)));
    }
  };

  // Values that are cleaned rather than rejected: a hand-edited list keeps its good entries.
  const SANITISERS = { customWords: sanitiseWords };
  const cleaned = (key, v) => (SANITISERS[key] && Array.isArray(v) ? SANITISERS[key](v) : v);

  // Keep only known keys whose values pass validation; anything else falls back to the default.
  // A hand-edited or corrupt file therefore can never put a bad value into the app.
  function merged(saved) {
    const out = { ...DEFAULTS };
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const k of Object.keys(DEFAULTS)) {
        const v = k in saved ? cleaned(k, saved[k]) : undefined;
        if (k in saved && k !== 'libraryPath' && SETTING_RULES[k](v)) out[k] = v;
      }
      // libraryPath is validated against the dialog pick only when *set*; a stored path is trusted.
      if (typeof saved.libraryPath === 'string' && path.isAbsolute(saved.libraryPath)) out.libraryPath = saved.libraryPath;
    }
    return out;
  }

  function loadSettingsSync() {
    if (settings) return settings;
    let saved = null;
    try { saved = JSON.parse(require('node:fs').readFileSync(settingsFile(), 'utf8')); } catch { /* missing or corrupt: defaults */ }
    settings = merged(saved);
    secret = saved && privateShelfModule.validSecret(saved.privateShelf) ? saved.privateShelf : null;
    return settings;
  }
  const loadSettings = async () => loadSettingsSync();

  // One write at a time: writeAtomic uses a fixed temp name, so overlapping writes would clash.
  let writeChain = Promise.resolve();
  const changeListeners = [];

  function setSetting(key, value) {
    // privateShelf is not in DEFAULTS on purpose: the renderer can never write the password hash.
    if (typeof key !== 'string' || key === 'privateShelf' || !Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return Promise.reject(new Error('Unknown setting'));
    value = cleaned(key, value);
    if (!SETTING_RULES[key](value)) return Promise.reject(new Error('Invalid value for ' + key));
    const s = loadSettingsSync();
    s[key] = value;
    const snapshot = serialise(s);
    writeChain = writeChain.catch(() => {}).then(() => writeAtomic(settingsFile(), snapshot));
    // Tell main right away (not after the disk write) so e.g. the native theme switches instantly.
    for (const cb of changeListeners) { try { cb(key, value); } catch { /* a listener must not break saving */ } }
    return writeChain.then(() => exposed(s));
  }

  // The password hash changes through here only.
  function saveSecret(next) {
    const s = loadSettingsSync();
    secret = next;
    const snapshot = serialise(s);
    writeChain = writeChain.catch(() => {}).then(() => writeAtomic(settingsFile(), snapshot));
    return writeChain;
  }
  const ps = privateShelfModule.create({ getSecret: () => secret, saveSecret });

  // What the renderer may see of the settings: a last-opened book that is hidden counts as unset
  // while the shelf is locked, so nothing (Home's Continue card, a fallback open) can name it.
  function libraryRootSync() {
    const s = loadSettingsSync();
    return (typeof s.libraryPath === 'string' && path.isAbsolute(s.libraryPath)) ? s.libraryPath : path.join(app.getPath('documents'), 'enWriter');
  }
  function hiddenLockedSync(id) {
    if (typeof id !== 'string' || ps.isUnlocked() || !secret) return false;
    try {
      const raw = JSON.parse(require('node:fs').readFileSync(libFile(libraryRootSync()), 'utf8'));
      return !!(raw && raw.privateShelf && Array.isArray(raw.privateShelf.books) && raw.privateShelf.books.includes(id));
    } catch { return false; }
  }
  function exposed(s) {
    const out = { ...s };
    if (hiddenLockedSync(out.lastBookId)) out.lastBookId = null;
    return out;
  }

  // ---- library location -------------------------------------------------------------------
  async function libraryRoot() {
    const s = await loadSettings();
    const dir = (typeof s.libraryPath === 'string' && path.isAbsolute(s.libraryPath))
      ? s.libraryPath
      : path.join(app.getPath('documents'), 'enWriter');
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  const libFile = (root) => path.join(root, 'library.json');

  // True only if `child` resolves strictly inside `root`.
  function inside(root, child) {
    const rel = path.relative(path.resolve(root), path.resolve(child));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  // ---- the private shelf's list of hidden books (part 7h) --------------------------------------
  function cleanPrivate(p) {
    const books = p && Array.isArray(p.books) ? [...new Set(p.books.filter((id) => typeof id === 'string' && ID_RE.test(id)))] : [];
    const name = p && typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 100) : 'Private';
    return { name, books };
  }
  const hiddenIn = (lib) => new Set(lib.privateShelf ? lib.privateShelf.books : []);
  // A book the renderer must not see or touch right now.
  const isHiddenNow = (lib, id) => !ps.isUnlocked() && hiddenIn(lib).has(id);

  function checkVersion(obj, what) {
    const v = obj && obj.formatVersion;
    if (typeof v === 'number' && v > FORMAT_VERSION) {
      const err = new Error(`${what} was made by a newer version of enWriter (format ${v}). Update enWriter to open it. Nothing was changed.`);
      err.code = 'NEWER_FORMAT';
      throw err;
    }
  }

  async function readJson(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
  }

  // ---- the open book ----------------------------------------------------------------------
  let open = null;   // { id, dir }

  function requireOpen() {
    if (!open) throw new Error('No book is open');
    return open;
  }
  const bookJson = () => path.join(requireOpen().dir, 'book.json');
  const filesDir = () => path.join(requireOpen().dir, 'Files');
  const fileFor = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid chapter id');
    return path.join(filesDir(), id + '.html');
  };

  // ---- project snapshots (part 7e) ------------------------------------------------------------
  // Everything about snapshots lives in snapshots.js; it only needs to know where the open book is.
  const snaps = snapshotsModule.create({ getDir: () => requireOpen().dir, shell, writeAtomic, checkVersion });
  // While a restore swaps the files, writes from the renderer are dropped rather than landing mid-swap.
  const writesPaused = () => snaps.isRestoring();

  // ---- scanning packages ------------------------------------------------------------------
  // Packages are the truth; library.json only adds shelves, order and colour on top.
  async function scanBooks(root) {
    const books = [];
    let entries = [];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { /* empty */ }
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.toLowerCase().endsWith(EXT)) continue;
      const dir = path.join(root, ent.name);
      const info = await readJson(path.join(dir, 'Meta', 'info.json'));
      if (!info || typeof info.bookId !== 'string' || !ID_RE.test(info.bookId)) continue;
      let newer = false;
      try { checkVersion(info, ent.name); } catch { newer = true; }
      const book = newer ? null : await readJson(path.join(dir, 'book.json'));
      let hasCover = false;
      try { await fs.access(path.join(dir, 'Meta', 'cover.webp')); hasCover = true; } catch { /* none */ }
      // Shown on the Home cover on hover. Words are the sum of the scenes (older saves kept them
      // on the chapter); "edited" is when book.json was last written, which every text save does.
      let words = 0;
      if (book && Array.isArray(book.chapters)) {
        for (const ch of book.chapters) {
          if (ch && Array.isArray(ch.scenes) && ch.scenes.length) for (const sc of ch.scenes) words += Number(sc && sc.words) || 0;
          else words += Number(ch && ch.words) || 0;
        }
      }
      let edited = null;
      try { edited = (await fs.stat(path.join(dir, 'book.json'))).mtimeMs; } catch { /* none */ }
      books.push({
        id: info.bookId,
        folder: ent.name,
        dir,
        title: (book && book.title) || ent.name.slice(0, -EXT.length),
        created: info.created || null,
        hasCover,
        words,
        edited,
        newerFormat: newer
      });
    }
    return books;
  }

  // A hidden book is "not found" while the shelf is locked, for every action that names a book. The one
  // exception is opening the book that is already open (book.js puts the previous book back that way).
  async function findBook(id, { allowOpen = false } = {}) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid book id');
    const root = await libraryRoot();
    const { lib } = await readLibrary(root);
    if (isHiddenNow(lib, id) && !(allowOpen && open && open.id === id)) throw new Error('Book not found');
    const hit = (await scanBooks(root)).find((b) => b.id === id);
    if (!hit) throw new Error('Book not found');
    if (!inside(root, hit.dir)) throw new Error('Book is outside the library');
    return { root, book: hit };
  }

  // ---- library.json -----------------------------------------------------------------------
  async function readLibrary(root) {
    const raw = await readJson(libFile(root));
    if (raw) checkVersion(raw, 'The library');
    const lib = {
      formatVersion: FORMAT_VERSION,
      migrated: !!(raw && raw.migrated),
      shelves: Array.isArray(raw && raw.shelves) ? raw.shelves : [],
      bookMeta: (raw && typeof raw.bookMeta === 'object' && raw.bookMeta) || {},
      // Part 7h, additive. Without a password the list means nothing, so it is dropped and its
      // books go back to a normal shelf the next time the library is saved.
      privateShelf: secret ? cleanPrivate(raw && raw.privateShelf) : null
    };
    return { lib, existed: !!raw };
  }

  // A library.json without the private shelf is written exactly as before (no extra key).
  const writeLibrary = (root, lib) => {
    const { privateShelf, ...rest } = lib;
    return writeAtomic(libFile(root), JSON.stringify(privateShelf ? { ...rest, privateShelf } : rest, null, 2));
  };

  // Make the shelves agree with what is on disk: drop missing books, append unshelved ones.
  function reconcile(lib, books) {
    const ids = new Set(books.map((b) => b.id));
    const seen = new Set();
    let changed = false;
    // Hidden books are claimed first, so they can never also sit on a normal shelf.
    if (lib.privateShelf) {
      const kept = lib.privateShelf.books.filter((id) => ids.has(id) && !seen.has(id) && seen.add(id));
      if (kept.length !== lib.privateShelf.books.length) changed = true;
      lib.privateShelf.books = kept;
    }
    if (!lib.shelves.length) { lib.shelves.push({ id: randomUUID(), name: 'My Books', books: [] }); changed = true; }
    for (const sh of lib.shelves) {
      if (!Array.isArray(sh.books)) { sh.books = []; changed = true; }
      const kept = sh.books.filter((id) => ids.has(id) && !seen.has(id) && seen.add(id));
      if (kept.length !== sh.books.length) changed = true;
      sh.books = kept;
    }
    for (const b of books) {
      if (!seen.has(b.id)) { lib.shelves[0].books.push(b.id); changed = true; }
    }
    return changed;
  }

  function publicBook(b, meta) {
    return { id: b.id, title: b.title, created: b.created, hasCover: b.hasCover, words: b.words, edited: b.edited,
      color: (meta && typeof meta.color === 'string') ? meta.color : null, newerFormat: b.newerFormat };
  }

  let migrationNotice = null;

  async function getLibrary(consumeNotice = false) {
    const root = await libraryRoot();
    const { lib, existed } = await readLibrary(root);
    await migrateIfNeeded(root, lib);
    const books = await scanBooks(root);
    if (reconcile(lib, books) || !existed) await writeLibrary(root, lib);
    // Only the renderer-facing library:get consumes the notice, so the internal call made by
    // novel:load cannot swallow it before the person sees it.
    const notice = migrationNotice;
    if (consumeNotice) migrationNotice = null;
    // While locked, hidden books are left out of everything and there is no `private` key at all.
    const unlocked = ps.isUnlocked();
    const hidden = hiddenIn(lib);
    const out = {
      formatVersion: FORMAT_VERSION,
      shelves: lib.shelves,
      books: books.filter((b) => unlocked || !hidden.has(b.id)).map((b) => publicBook(b, lib.bookMeta[b.id])),
      migrationNotice: notice
    };
    if (unlocked && lib.privateShelf) out.private = { name: lib.privateShelf.name, books: [...lib.privateShelf.books] };
    return out;
  }

  // Accepts only the fields the renderer may change, with strict shape checks.
  async function putLibrary(input) {
    const root = await libraryRoot();
    const { lib } = await readLibrary(root);
    const books = await scanBooks(root);
    const ids = new Set(books.map((b) => b.id));
    if (!input || !Array.isArray(input.shelves) || input.shelves.length > 200) throw new Error('Invalid library');
    // Part 7h: which books are hidden can change only while unlocked. While locked the renderer
    // knows nothing about them, so whatever it sends is ignored for them and they stay as they are.
    const unlocked = ps.isUnlocked();
    const hiddenBefore = hiddenIn(lib);
    let hiddenNow = lib.privateShelf;
    if (unlocked && lib.privateShelf && input.private && typeof input.private === 'object') {
      const c = cleanPrivate(input.private);
      hiddenNow = { name: c.name, books: c.books.filter((id) => ids.has(id)) };
    }
    const hiddenSet = new Set(hiddenNow ? hiddenNow.books : []);
    const shelves = input.shelves.map((sh) => {
      if (!sh || typeof sh.id !== 'string' || !ID_RE.test(sh.id)) throw new Error('Invalid shelf id');
      const name = typeof sh.name === 'string' ? sh.name.slice(0, 200) : 'Shelf';
      const list = Array.isArray(sh.books) ? sh.books.filter((id) => typeof id === 'string' && ID_RE.test(id) && ids.has(id) && !hiddenSet.has(id)) : [];
      return { id: sh.id, name, books: list };
    });
    lib.shelves = shelves;
    lib.privateShelf = hiddenNow;
    if (input.bookMeta && typeof input.bookMeta === 'object') {
      const meta = {};
      for (const [id, m] of Object.entries(input.bookMeta)) {
        if (!ids.has(id) || !m || typeof m !== 'object') continue;
        if (!unlocked && hiddenBefore.has(id)) continue;   // not the renderer's to set
        meta[id] = { color: typeof m.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(m.color) ? m.color : null };
      }
      // The colours of hidden books were never sent while locked; keep them as they were.
      if (!unlocked) for (const id of hiddenBefore) if (lib.bookMeta[id]) meta[id] = lib.bookMeta[id];
      lib.bookMeta = meta;
    }
    reconcile(lib, books);   // never lose a book because the renderer forgot to shelve it
    await writeLibrary(root, lib);
    return true;
  }

  // ---- creating, renaming, trashing --------------------------------------------------------
  const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
  function folderBase(title) {
    const t = String(title || '').replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 80);
    return t || 'Untitled Novel';
  }

  async function uniqueFolder(root, title) {
    const base = folderBase(title);
    for (let n = 1; n < 1000; n++) {
      const name = (n === 1 ? base : `${base} ${n}`) + EXT;
      try { await fs.access(path.join(root, name)); } catch { return name; }
    }
    return `${base} ${randomUUID().slice(0, 8)}${EXT}`;
  }

  function newBookData(title) {
    const first = { id: randomUUID(), title: 'Chapter 1', words: 0, synopsis: '' };
    return { first, index: { title, chapters: [first] } };
  }

  async function writeInfo(dir, bookId, created) {
    await writeAtomic(path.join(dir, 'Meta', 'info.json'), JSON.stringify({
      formatVersion: FORMAT_VERSION, bookId, created: created || new Date().toISOString(), appVersion: app.getVersion()
    }, null, 2));
  }

  async function createBook(title) {
    const root = await libraryRoot();
    const clean = (typeof title === 'string' && title.trim()) ? title.trim().slice(0, 200) : 'Untitled Novel';
    const folder = await uniqueFolder(root, clean);
    const dir = path.join(root, folder);
    if (!inside(root, dir)) throw new Error('Invalid book name');
    const id = randomUUID();
    await fs.mkdir(path.join(dir, 'Files'), { recursive: true });
    await fs.mkdir(path.join(dir, 'Meta'), { recursive: true });
    const { first, index } = newBookData(clean);
    await writeAtomic(path.join(dir, 'Files', first.id + '.html'), '');
    await writeAtomic(path.join(dir, 'book.json'), JSON.stringify(index, null, 2));
    await writeInfo(dir, id);
    const { lib } = await readLibrary(root);
    reconcile(lib, await scanBooks(root));
    await writeLibrary(root, lib);
    return { id, title: clean };
  }

  async function renameBook(id, title) {
    const { root, book } = await findBook(id);
    if (book.newerFormat) throw new Error('This book needs a newer enWriter. Nothing was changed.');
    const clean = String(title || '').trim().slice(0, 200);
    if (!clean) throw new Error('A book needs a title');
    const data = (await readJson(path.join(book.dir, 'book.json'))) || {};
    data.title = clean;
    await writeAtomic(path.join(book.dir, 'book.json'), JSON.stringify(data, null, 2));
    // Move the folder too, unless the name would not change.
    let dir = book.dir;
    if (folderBase(clean) + EXT !== book.folder) {
      const folder = await uniqueFolder(root, clean);
      const next = path.join(root, folder);
      if (!inside(root, next)) throw new Error('Invalid book name');
      await fs.rename(book.dir, next);
      dir = next;
    }
    if (open && open.id === id) open.dir = dir;
    return { id, title: clean };
  }

  async function deleteBook(id) {
    const { root, book } = await findBook(id);
    if (open && open.id === id) open = null;
    await shell.trashItem(book.dir);   // OS trash, never fs.rm: the user can always get it back
    const { lib } = await readLibrary(root);
    reconcile(lib, await scanBooks(root));
    delete lib.bookMeta[id];
    await writeLibrary(root, lib);
    return true;
  }

  // Cover images live in Meta/cover.webp. The renderer sends a data URL it made itself; we accept
  // only a webp data URL of a sane size and decode it here, so nothing else can be written.
  const COVER_RE = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/;
  const COVER_MAX = 3 * 1024 * 1024;

  async function getCover(id) {
    const { book } = await findBook(id);
    try {
      const buf = await fs.readFile(path.join(book.dir, 'Meta', 'cover.webp'));
      return 'data:image/webp;base64,' + buf.toString('base64');
    } catch { return null; }
  }

  async function setCover(id, dataUrl) {
    const { book } = await findBook(id);
    if (book.newerFormat) throw new Error('This book needs a newer enWriter. Nothing was changed.');
    const file = path.join(book.dir, 'Meta', 'cover.webp');
    if (dataUrl === null) { await fs.rm(file, { force: true }); return true; }
    const m = typeof dataUrl === 'string' && dataUrl.length <= COVER_MAX * 1.4 ? COVER_RE.exec(dataUrl) : null;
    if (!m) throw new Error('Invalid cover image');
    const buf = Buffer.from(m[1], 'base64');
    if (!buf.length || buf.length > COVER_MAX) throw new Error('Invalid cover image');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
    return true;
  }

  async function openBook(id) {
    const { book } = await findBook(id, { allowOpen: true });
    const info = await readJson(path.join(book.dir, 'Meta', 'info.json'));
    checkVersion(info, book.folder);
    // A restore that was interrupted (crash, power cut) is finished before anything is read.
    try { await snaps.recover(book.dir); } catch { /* the book is opened as it is; nothing is made worse */ }
    const data = await readJson(path.join(book.dir, 'book.json'));
    if (data) checkVersion(data, book.folder);
    open = { id: book.id, dir: book.dir };
    snaps.sweep(book.dir).catch(() => {});
    try { await setSetting('lastBookId', book.id); } catch { /* not critical */ }
    return { id: book.id, title: book.title };
  }

  // ---- renderer-facing novel:load / writes (same channels as before) -----------------------
  async function loadNovel() {
    if (!open) {
      // Old renderer code just calls novel:load: open the last book, else the first, else make one.
      const lib = await getLibrary();
      const s = await loadSettings();
      const usable = lib.books.filter((b) => !b.newerFormat);
      let pick = usable.find((b) => b.id === s.lastBookId) || usable[0];
      if (!pick) {
        if (lib.books.length) throw Object.assign(new Error('Every book in the library needs a newer enWriter.'), { code: 'NEWER_FORMAT' });
        pick = await createBook('Untitled Novel');
      }
      await openBook(pick.id);
    }
    const { dir } = requireOpen();
    await fs.mkdir(path.join(dir, 'Files'), { recursive: true });
    const data = await readJson(path.join(dir, 'book.json'));
    if (data) { checkVersion(data, 'This book'); return data; }
    const { first, index } = newBookData('Untitled Novel');
    await writeAtomic(path.join(dir, 'Files', first.id + '.html'), '');
    await writeAtomic(path.join(dir, 'book.json'), JSON.stringify(index, null, 2));
    return index;
  }

  async function writeIndex(index) {
    if (!index || typeof index !== 'object') throw new Error('Invalid book data');
    if (writesPaused()) return false;
    return writeAtomic(bookJson(), JSON.stringify(index, null, 2));
  }

  // ---- one-time migration of userData/novel ------------------------------------------------
  async function migrateIfNeeded(root, lib) {
    if (lib.migrated) return;
    const old = path.join(app.getPath('userData'), 'novel');
    let hasOld = false;
    try { hasOld = (await fs.stat(old)).isDirectory(); } catch { /* nothing to migrate */ }
    const books = await scanBooks(root);
    if (hasOld && !books.length) {
      try {
        const index = await readJson(path.join(old, 'index.json'));
        if (index) {
          const title = (index.title && String(index.title).trim()) || 'Untitled Novel';
          const folder = await uniqueFolder(root, title);
          const dir = path.join(root, folder);
          await fs.mkdir(path.join(dir, 'Meta'), { recursive: true });
          // Copy, never move: the original stays as a backup.
          try { await fs.cp(path.join(old, 'chapters'), path.join(dir, 'Files'), { recursive: true }); }
          catch { await fs.mkdir(path.join(dir, 'Files'), { recursive: true }); }
          await writeAtomic(path.join(dir, 'book.json'), JSON.stringify(index, null, 2));
          await writeInfo(dir, randomUUID());
          migrationNotice = `Your book “${title}” now lives in your library at ${root}. The original was left untouched.`;
        }
      } catch {
        // Copy failed half way: leave the flag unset so it is retried next launch.
        return;
      }
    }
    lib.migrated = true;
    reconcile(lib, await scanBooks(root));
    await writeLibrary(root, lib);
  }

  // ---- changing the library location (part 5e) -----------------------------------------------
  // The renderer never sends a path. It asks for a folder dialog (which records pickedFolder) and
  // then names an action; everything below works on that one remembered folder.
  let relocating = false;

  // Every file's relative path and size, so a copy can be compared with its source.
  // Anything that is not a plain file or folder (links, sockets) is ignored on both sides.
  async function listTree(dir, base = dir, out = new Map()) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      const rel = path.relative(base, p);
      if (ent.isDirectory()) { out.set(rel + path.sep, 0); await listTree(p, base, out); }
      else if (ent.isFile()) out.set(rel, (await fs.stat(p)).size);
    }
    return out;
  }

  async function verifyCopy(srcDir, dstDir, newer) {
    const a = await listTree(srcDir), b = await listTree(dstDir);
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (b.get(k) !== v) return false;
    if (!(await readJson(path.join(dstDir, 'Meta', 'info.json')))) return false;
    // A book from a newer enWriter is copied as is; we do not claim to understand its book.json.
    if (!newer && !(await readJson(path.join(dstDir, 'book.json')))) return false;
    return true;
  }

  const realOr = async (p) => { try { return await fs.realpath(p); } catch { return path.resolve(p); } };

  // Looks at the folder the person picked and refuses the ones that can never work.
  async function checkFolder() {
    const p = pickedFolder;
    if (typeof p !== 'string') throw new Error('Choose a folder first.');
    let st = null;
    try { st = await fs.stat(p); } catch { /* handled below */ }
    if (!st || !st.isDirectory()) throw new Error('That folder cannot be read. Choose another one.');
    const real = await realOr(p);
    // A library cannot live inside a book: walk up through every parent.
    const hiddenHere = hiddenIn((await readLibrary(await libraryRoot())).lib);
    for (let d = real, prev = ''; d !== prev; prev = d, d = path.dirname(d)) {
      const info = await readJson(path.join(d, 'Meta', 'info.json'));
      if (d.toLowerCase().endsWith(EXT) || (info && typeof info.bookId === 'string')) {
        // A hidden book is not named while the shelf is locked.
        const secretBook = info && !ps.isUnlocked() && hiddenHere.has(info.bookId);
        throw new Error('That folder is inside a book' + (secretBook ? '' : ' (' + path.basename(d) + ')') + '. Choose a folder outside any .mwt book.');
      }
    }
    const current = await realOr(await libraryRoot());
    const same = process.platform === 'linux' ? real === current : real.toLowerCase() === current.toLowerCase();
    if (same) throw new Error('That is already your library folder. Choose a different one.');
    // Probe for write access with a real file: permission bits do not tell the whole story.
    const probe = path.join(p, '.enwriter-write-test-' + randomUUID().slice(0, 8));
    try { await fs.writeFile(probe, ''); await fs.rm(probe, { force: true }); }
    catch { throw new Error('enWriter cannot write to that folder (it may be read-only). Choose a folder you can save to.'); }
    const entries = (await fs.readdir(p)).filter((n) => !n.startsWith('.'));
    const raw = await readJson(libFile(p));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      checkVersion(raw, 'The library in that folder');
      // The other library's hidden books (if any) are not counted while locked, same as our own.
      const theirs = secret ? cleanPrivate(raw.privateShelf) : { books: [] };
      const found = await scanBooks(p);
      const shown = ps.isUnlocked() ? found.length : found.filter((b) => !theirs.books.includes(b.id)).length;
      return { kind: 'library', books: shown, shelves: Array.isArray(raw.shelves) ? raw.shelves.length : 0 };
    }
    return { kind: entries.length ? 'other' : 'empty', books: 0, shelves: 0 };
  }

  async function inspectFolder() {
    const r = await checkFolder();
    return { path: pickedFolder, name: path.basename(pickedFolder) || pickedFolder, ...r };
  }

  async function libraryInfo() {
    const root = await libraryRoot();
    const { lib } = await readLibrary(root);
    const books = await scanBooks(root);
    // Hidden books are not counted while locked, and the private shelf is never counted as a shelf.
    const hidden = hiddenIn(lib);
    const count = ps.isUnlocked() ? books.length : books.filter((b) => !hidden.has(b.id)).length;
    return { path: root, books: count, shelves: Math.max(1, lib.shelves.length) };
  }

  const rmQuiet = (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  async function applyFolder(mode) {
    if (relocating) throw new Error('A library change is already running. Wait for it to finish.');
    if (!['move', 'fresh', 'open'].includes(mode)) throw new Error('Unknown action');
    relocating = true;
    try {
      const dest = pickedFolder;
      const found = await checkFolder();
      const notes = [];
      let moved = 0;

      if (mode === 'open') {
        if (found.kind !== 'library') throw new Error('There is no enWriter library in that folder (no library.json). Nothing was changed.');
      } else if (found.kind === 'library') {
        throw new Error('That folder already holds a library. Choose “Open an existing library” instead. Nothing was changed.');
      } else if (mode === 'fresh') {
        await writeLibrary(dest, { formatVersion: FORMAT_VERSION, migrated: true, shelves: [{ id: randomUUID(), name: 'My Books', books: [] }], bookMeta: {} });
      } else {
        const srcRoot = await libraryRoot();
        const { lib } = await readLibrary(srcRoot);
        const books = await scanBooks(srcRoot);
        // Messages never name a hidden book while the shelf is locked.
        const hid = hiddenIn(lib);
        const nm = (b) => (!ps.isUnlocked() && hid.has(b.id) ? 'A book' : '“' + b.title + '”');
        const made = [];
        const rollback = async () => { for (const d of made) await rmQuiet(d); await rmQuiet(libFile(dest)); };
        for (const b of books) {
          const folder = await uniqueFolder(dest, b.folder.slice(0, -EXT.length));
          const to = path.join(dest, folder);
          made.push(to);
          let ok = false;
          try { await fs.cp(b.dir, to, { recursive: true, errorOnExist: true }); ok = await verifyCopy(b.dir, to, b.newerFormat); } catch { ok = false; }
          if (!ok) {
            await rollback();
            throw new Error(nm(b) + ' could not be copied and checked. Nothing was moved and all your books are still where they were.');
          }
        }
        try { await writeLibrary(dest, { ...lib, formatVersion: FORMAT_VERSION, migrated: true }); }
        catch { await rollback(); throw new Error('The library file could not be written in the new folder. Nothing was moved.'); }
        moved = books.length;
        // From here on the copies are good. Originals go to the OS trash, so even now nothing is lost.
        // Settings first: if that fails we undo and the originals are still untouched.
        try { await setSetting('libraryPath', dest); }
        catch { await rollback(); throw new Error('The new location could not be saved. Nothing was moved.'); }
        open = null;
        ps.lock();
        for (const b of books) {
          try { await shell.trashItem(b.dir); }
          catch { notes.push(nm(b) + ' was copied but the original could not be removed from ' + srcRoot + '.'); }
        }
        return { mode, path: dest, moved, notes };
      }

      await setSetting('libraryPath', dest);
      open = null;
      ps.lock();   // a different library: whatever was unlocked stays behind
      // The last-opened id belongs to the other library.
      try { await setSetting('lastBookId', null); } catch { /* not critical */ }
      return { mode, path: dest, moved, notes };
    } finally { relocating = false; }
  }

  // ---- private shelf: setup and removal (part 7h) -------------------------------------------------
  // Turning it on starts from an empty list: whatever an old library.json still says about hidden
  // books is dropped first, so no book ends up hidden behind a password it was not hidden with.
  async function enablePrivate(password) {
    if (ps.enabled()) throw new Error('A private shelf password is already set.');
    const root = await libraryRoot();
    const { lib, existed } = await readLibrary(root);   // no secret yet: privateShelf is null here
    if (existed) { reconcile(lib, await scanBooks(root)); await writeLibrary(root, lib); }
    await ps.set(password);
    const after = await readLibrary(root);
    after.lib.privateShelf = { name: 'Private', books: [] };
    await writeLibrary(root, after.lib);
    return true;
  }

  // Checks the password, moves every hidden book back to a normal shelf, and only then forgets the password.
  async function disablePrivate(password) {
    const r = await ps.check(password);
    if (!r.ok) return r;
    const root = await libraryRoot();
    const { lib } = await readLibrary(root);
    lib.privateShelf = null;                 // reconcile() puts every unshelved book on the first shelf
    reconcile(lib, await scanBooks(root));
    await writeLibrary(root, lib);
    await ps.clear();
    return { ok: true };
  }

  // ---- IPC --------------------------------------------------------------------------------
  function register(ipcMain) {
    const h = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));

    h('novel:load', loadNovel);
    h('index:write', writeIndex);
    h('chapter:read', async (id) => { try { return await fs.readFile(fileFor(id), 'utf8'); } catch { return ''; } });
    h('chapter:write', (id, html) => {
      if (typeof html !== 'string') throw new Error('Invalid content');
      if (writesPaused()) return false;
      return writeAtomic(fileFor(id), html);
    });
    h('chapter:create', async () => {
      const id = randomUUID();
      if (writesPaused()) return id;
      await writeAtomic(fileFor(id), '');
      return id;
    });
    h('chapter:delete', (id) => (writesPaused() ? false : fs.rm(fileFor(id), { force: true })));
    snaps.register(h);

    // Part 7h. `status` says only whether the feature is on and whether it is unlocked.
    h('private:status', () => ps.status());
    h('private:set', enablePrivate);
    h('private:change', (current, next) => ps.change(current, next));
    h('private:unlock', (password) => ps.unlock(password));
    h('private:lock', () => ps.lock());
    h('private:disable', disablePrivate);

    h('library:get', () => getLibrary(true));
    h('library:write', putLibrary);
    h('book:create', createBook);
    h('book:open', openBook);
    h('book:close', async () => { open = null; return true; });
    h('book:rename', renameBook);
    h('book:delete', deleteBook);
    h('book:cover-get', getCover);
    h('book:cover-set', setCover);
    h('book:reveal', async (id) => { const { book } = await findBook(id); shell.showItemInFolder(book.dir); return true; });
    h('library:choose-folder', async () => {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      pickedFolder = r.filePaths[0];
      return pickedFolder;
    });
    h('library:inspect-folder', inspectFolder);
    h('library:apply-folder', applyFolder);
    h('library:info', libraryInfo);
    h('library:reveal', async () => {
      const root = await libraryRoot();
      // Select library.json when there is one so the folder opens; otherwise open the folder itself.
      try { await fs.access(libFile(root)); shell.showItemInFolder(libFile(root)); } catch { await shell.openPath(root); }
      return true;
    });
    // Blocking read so the page can set theme, accent and zoom before its first paint.
    ipcMain.on('settings:get-sync', (e) => { e.returnValue = exposed(loadSettingsSync()); });
    h('settings:get', async () => exposed(await loadSettings()));
    h('settings:set', setSetting);
  }

  // Once per launch: deleted snapshots older than a week go to the OS trash, in every book of the library.
  async function startup() {
    const root = await libraryRoot();
    for (const b of await scanBooks(root)) { try { await snaps.sweep(b.dir); } catch { /* next launch */ } }
  }

  return { register, startup, lockPrivate: () => ps.lock(), getSettings: loadSettingsSync, onSettingChange: (cb) => { changeListeners.push(cb); } };
}

module.exports = { create, FORMAT_VERSION, SPELL_LANGUAGES, sanitiseWords };
