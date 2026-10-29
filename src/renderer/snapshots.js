// Project snapshots (part 7e): Ctrl+S keeps a copy of the whole project, and the Darlings tab lists
// the copies so the writer can look inside one and go back to it.
// The copies themselves live in the book's package, written by the main process (snapshots.js there).
// This file is everything around them: Ctrl+S, the snapshot cards and preview in Darlings, and Restore.
//
// Restore is the one delicate step. The order is:
//   1. write everything pending (editor text, index, note bodies),
//   2. freeze autosave and make the page inert, so nothing can be typed or written,
//   3. main takes a "Before restore" snapshot and swaps the book's files in one crash-safe step,
//   4. reload the book from disk (emw.book.open), which resets every view and every autosave flag,
//   5. unfreeze, go back to the view the writer was on, and offer Undo.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const emw = window.emw;
  const api = window.api;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const failSafe = async (fn) => { try { await fn(); } catch { /* one failing hook must not stop the others */ } };
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const errText = (err) => (err && err.message ? String(err.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : '');

  let items = [];       // the book's snapshots, newest first (read from main)
  let version = 0;      // bumped whenever `items` changes, so the preview knows to redraw
  let sel = '';         // the snapshot shown in the preview (view state, not data)
  let busy = false;     // a save or restore is running
  let lastPress = 0;
  let loadToken = 0;
  let outlineToken = 0;

  // ---- wording --------------------------------------------------------------------------------
  const REASONS = { 'before-restore': 'Before restore', 'before-replace-all': 'Before Replace All' };
  const reasonLabel = (r) => REASONS[r] || (r ? r.charAt(0).toUpperCase() + r.slice(1).replace(/-/g, ' ') : 'Automatic');
  const stamp = () => new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const when = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  let rtf = null;
  try { rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }); } catch { /* the date alone is enough */ }
  const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  function ago(t) {
    const s = (t - Date.now()) / 1000;
    if (!rtf || Math.abs(s) < 45) return 'just now';
    for (const [unit, sec] of UNITS) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
    return rtf.format(Math.round(s / 60), 'minute');
  }
  const size = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

  const CHANGE_KEYS = [['chapters', 'chapter'], ['scenes', 'scene'], ['words', 'word'], ['characters', 'character'], ['places', 'place'], ['notes', 'note'], ['tags', 'tag'], ['plotlines', 'plotline']];
  // "+1 chapter, −230 words": what differs from the snapshot taken just before this one.
  function change(s, prev) {
    if (!prev) return 'The first snapshot';
    const parts = [];
    for (const [k, w] of CHANGE_KEYS) {
      const d = (s.counts[k] || 0) - (prev.counts[k] || 0);
      if (d) parts.push(`${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString()} ${w}${Math.abs(d) === 1 ? '' : 's'}`);
    }
    if (!parts.length) return 'No change since the one before';
    return 'Since the one before: ' + parts.slice(0, 4).join(', ') + (parts.length > 4 ? ` and ${parts.length - 4} more` : '');
  }
  const mainCounts = (c) => [plural(c.chapters, 'chapter'), plural(c.scenes, 'scene'), plural(c.words, 'word')].join(' · ');
  const otherCounts = (c) => [plural(c.characters, 'character'), plural(c.places, 'place'), plural(c.notes, 'note'), plural(c.tags, 'tag')].join(' · ');
  const hay = (s) => ['snapshot', s.label, s.kind === 'auto' ? reasonLabel(s.reason) : '', when(s.createdAt)].join('\n').toLowerCase();

  // ---- the list ---------------------------------------------------------------------------------
  async function refresh() {
    const my = ++loadToken;
    const bookId = emw.book.id;
    if (!bookId) { items = []; sel = ''; version++; return; }
    let list = null;
    try { list = await api.snapshotList(); } catch { /* keep what we have; the tab shows it */ }
    if (my !== loadToken || bookId !== emw.book.id) return;   // another refresh, or another book, took over
    if (Array.isArray(list)) items = list;
    if (sel && !items.some((i) => i.id === sel)) sel = '';
    version++;
    if (emw.view() === 'darlings') emw.darlings.render();
  }

  const find = (id) => items.find((i) => i.id === id) || null;
  const prevOf = (s) => items[items.indexOf(s) + 1] || null;

  // ---- cards --------------------------------------------------------------------------------------
  function card(s) {
    const c = el('div', 'dl-card snap-card');
    c.dataset.id = s.id;
    c.dataset.snap = '1';
    c.tabIndex = 0;
    c.setAttribute('role', 'listitem');
    c.setAttribute('aria-current', String(s.id === sel));
    c.setAttribute('aria-label', `Snapshot: ${s.label}`);
    c.style.setProperty('--c', s.kind === 'auto' ? 'var(--muted)' : 'var(--accent)');
    const head = el('div', 'snap-head');
    head.append(el('span', 'dl-kind', 'Snapshot'));
    if (s.kind === 'auto') head.append(el('span', 'dl-badge', `Auto · ${reasonLabel(s.reason)}`));
    c.append(head, el('div', 'dl-title', s.label));
    c.append(el('div', 'snap-counts', mainCounts(s.counts)), el('div', 'snap-counts', otherCounts(s.counts)));
    c.append(el('div', 'snap-change', change(s, prevOf(s))));
    c.append(el('div', 'dl-meta', `${when(s.createdAt)} · ${ago(s.createdAt)} · ${size(s.bytes)}`));
    const acts = el('div', 'dl-actions');
    acts.append(btn('dl-restore', 'Restore'), btn('dl-sec dl-ren', 'Rename'), btn('dl-del', 'Delete'));
    c.append(acts);
    return c;
  }
  function btn(cls, text) {
    const b = el('button', cls, text);
    b.type = 'button';
    return b;
  }

  // Used by darlings.js to put the cards into its list. `at` lets it sort darlings and snapshots together.
  const cards = (query) => items.filter((s) => !query || hay(s).includes(query)).map((s) => ({ at: s.createdAt, node: card(s) }));
  const countText = (shown) => (shown === items.length ? plural(items.length, 'snapshot') : `${shown} of ${plural(items.length, 'snapshot')}`);

  function select(id) {
    sel = id || '';
    if (sel) emw.darlings.deselect();
    for (const c of $('#dl-list').children) c.setAttribute('aria-current', String(c.dataset.id === sel));
  }

  // ---- preview: what is inside --------------------------------------------------------------------
  function renderPreview(host) {
    const s = find(sel);
    if (!s) return;
    const key = `${s.id}|${version}`;
    if (host.firstElementChild && host.firstElementChild.dataset.snapKey === key) return;   // already showing it
    const my = ++outlineToken;
    const head = el('header', 'dl-ph');
    head.dataset.snapKey = key;
    const kind = el('div', 'snap-head');
    kind.append(el('span', 'dl-kind', 'Snapshot'));
    if (s.kind === 'auto') kind.append(el('span', 'dl-badge', `Auto · ${reasonLabel(s.reason)}`));
    const title = el('h2', 'dl-pt', s.label);
    head.append(kind, title, el('p', 'dl-meta', `${when(s.createdAt)} · ${ago(s.createdAt)} · ${size(s.bytes)}`));
    const acts = el('div', 'dl-actions');
    const r = btn('dl-restore', 'Restore');
    const n = btn('dl-sec', 'Rename');
    const x = btn('dl-del shown', 'Delete');
    r.addEventListener('click', () => restore(s.id));
    n.addEventListener('click', () => startRename(s.id, title));
    x.addEventListener('click', () => remove(s.id));
    acts.append(r, n, x);
    head.append(acts);

    const body = el('div', 'dl-pbody');
    const facts = el('dl', 'snap-facts');
    for (const [k, w] of CHANGE_KEYS) {
      facts.append(el('dt', '', w.charAt(0).toUpperCase() + w.slice(1) + 's'), el('dd', '', (s.counts[k] || 0).toLocaleString()));
    }
    body.append(facts, el('p', 'dl-desc', change(s, prevOf(s))));
    const outlineHost = el('div', 'snap-outline');
    outlineHost.append(el('p', 'hint', 'Reading the outline…'));
    body.append(el('h3', 'dl-h', 'Inside this snapshot'), outlineHost);
    host.replaceChildren(head, body);

    api.snapshotOutline(s.id).then((o) => {
      if (my !== outlineToken) return;   // the writer picked something else meanwhile
      outlineHost.replaceChildren(outline(o));
    }).catch(() => {
      if (my === outlineToken) outlineHost.replaceChildren(el('p', 'hint', 'The outline could not be read.'));
    });
  }

  // Read-only: titles and word counts only, built with textContent.
  function outline(o) {
    const ol = el('ol', 'snap-chapters');
    o.chapters.forEach((ch, i) => {
      const li = el('li', 'snap-ch');
      const row = el('div', 'snap-row');
      row.append(el('span', 'snap-name', ch.title.trim() || `Chapter ${i + 1}`), el('span', 'snap-n', ch.words.toLocaleString()));
      li.append(row);
      if (ch.scenes.length) {
        const ul = el('ul', 'snap-scenes');
        for (const sc of ch.scenes) {
          const r = el('li', 'snap-row');
          const name = el('span', 'snap-name', sc.title.trim() || 'Untitled scene');
          if (!sc.title.trim()) name.classList.add('untitled');
          r.append(name, el('span', 'snap-n', sc.words.toLocaleString()));
          ul.append(r);
        }
        li.append(ul);
      }
      ol.append(li);
    });
    if (!o.chapters.length) return el('p', 'hint', 'This snapshot has no chapters.');
    return ol;
  }

  // ---- rename, delete ---------------------------------------------------------------------------------
  function startRename(id, target) {
    const s = find(id);
    if (!s || !target) return;
    emw.rename(target, {
      value: s.label,
      placeholder: 'Snapshot name',
      onCommit: async (v) => {
        if (!v || v === s.label) return;
        try { await api.snapshotRename(id, v); } catch (err) { emw.toast(errText(err) || 'Could not rename that snapshot'); }
        await refresh();
      },
      onDone: () => emw.darlings.render()
    });
  }

  async function remove(id) {
    const s = find(id);
    if (!s) return;
    try { await api.snapshotRemove(id); }
    catch (err) { emw.toast(errText(err) || 'Could not delete that snapshot'); await refresh(); return; }
    if (sel === id) sel = '';
    await refresh();
    // Deleted snapshots wait in .removed for a week, so Undo is a move back, not a copy.
    emw.toast(`Deleted snapshot “${clip(s.label, 40)}”`, {
      ms: 8000,
      action: { label: 'Undo', run: async () => {
        try { await api.snapshotRestoreRemoved(id); } catch { emw.toast('That snapshot could not be brought back'); }
        await refresh();
      } }
    });
  }

  // ---- saving -----------------------------------------------------------------------------------------
  // Everything pending is written before the copy, so the snapshot holds what is on screen.
  async function settle() {
    await failSafe(() => emw.actions.flush && emw.actions.flush());
    for (const f of emw.flushHooks) await failSafe(f);
  }

  async function saveSnapshot({ label = '', named = false } = {}) {
    if (!emw.book.id || busy) return;
    const now = Date.now();
    if (!named && now - lastPress < 2000) return;   // a held or repeated Ctrl+S
    lastPress = now;
    busy = true;
    try {
      await settle();
      const r = await api.snapshotCreate({ kind: 'manual', label: label || stamp(), force: named });
      await refresh();
      if (r && r.created) {
        emw.flashSaveState('Snapshot saved');
        emw.toast('Snapshot saved', { ms: 3500, action: { label: 'Show', run: () => emw.darlings.openMode('snapshots', r.snapshot.id) } });
      } else {
        emw.toast('Saved. No changes since the last snapshot.', { ms: 3500 });
      }
    } catch (err) {
      emw.toast((errText(err) || 'The snapshot could not be saved') + '. Your writing is still saved.', { ms: 7000 });
    } finally { busy = false; }
  }

  async function saveNamed() {
    if (!emw.book.id || busy) return;
    const name = await emw.ask({ message: 'Name this snapshot', input: stamp(), okLabel: 'Save snapshot' });
    if (name === null) return;
    await saveSnapshot({ label: name.trim() || stamp(), named: true });
  }

  // For other features (Replace All, whole-book font changes): a safety copy before they change many files.
  // Resolves to the snapshot's id, or null if it could not be made (the caller decides whether to go on).
  async function auto(reason, label) {
    if (!emw.book.id) return null;
    try {
      await settle();
      const r = await api.snapshotCreate({ kind: 'auto', reason, label });
      await refresh();
      return r && r.snapshot ? r.snapshot.id : null;
    } catch { return null; }
  }

  // ---- restoring ------------------------------------------------------------------------------------------
  async function restore(id, { undo = false } = {}) {
    const s = find(id);
    if (!emw.book.id || busy) return;
    busy = true;
    const bookId = emw.book.id;
    const view = emw.view();
    const wasInert = document.body.inert;
    let res = null;
    let failure = '';
    try {
      await settle();
      emw.freezeSave(true);          // from here nothing in this window writes to the book
      document.body.inert = true;
      emw.setSaveState('Restoring…');
      try {
        res = await api.snapshotRestore(id);
      } catch (err) {
        failure = errText(err) || 'That snapshot could not be restored.';
      }
      // The main process says "Nothing was changed" for failures before the swap. Any other failure may have
      // left the files half-way, so then (and after a success) the book is read again from disk.
      if (!/Nothing was changed/.test(failure)) {
        const ok = await emw.book.open(bookId);
        if (!ok) {
          // The book could not be read back. Leave it (nothing is written once the id is null) and go Home.
          await emw.book.close();
          emw.showView('home');
          emw.toast(failure || 'The snapshot was restored, but the book could not be reopened. Open it again from Home.', { ms: 9000 });
          return;
        }
        emw.showView(view);
      }
      if (failure) { emw.toast(failure, { ms: 8000 }); return; }
      await refresh();
      if (undo) {
        emw.toast('Back where you were. The snapshot you left is still in Snapshots.', { ms: 6000 });
      } else {
        emw.toast(`Restored “${clip(s ? s.label : 'snapshot', 40)}”`, {
          ms: 12000,
          action: { label: 'Undo', run: () => restore(res.undoId, { undo: true }) }
        });
      }
    } finally {
      document.body.inert = wasInert;
      emw.freezeSave(false);
      busy = false;
    }
  }

  // ---- events: snapshot cards -----------------------------------------------------------------------------
  const listEl = $('#dl-list');
  const cardOf = (e) => { const c = e.target.closest?.('.dl-card'); return c && c.dataset.snap ? c : null; };
  // Selecting only moves the highlight and redraws the preview; the list itself is not rebuilt, so a rename
  // that starts on a double-click is not thrown away by the first click's redraw.
  const pick = (c) => { select(c.dataset.id); renderPreview($('#dl-preview')); };

  listEl.addEventListener('click', (e) => {
    const c = cardOf(e);
    if (!c) return;
    const id = c.dataset.id;
    if (e.target.closest('.dl-restore')) restore(id);
    else if (e.target.closest('.dl-ren')) startRename(id, c.querySelector('.dl-title'));
    else if (e.target.closest('.dl-del')) remove(id);
    else if (!e.target.closest('.rename')) pick(c);
  });
  listEl.addEventListener('dblclick', (e) => {
    const c = cardOf(e);
    if (c && e.target.closest('.dl-title')) startRename(c.dataset.id, c.querySelector('.dl-title'));
  });
  listEl.addEventListener('keydown', (e) => {
    const c = cardOf(e);
    if (!c || e.target !== c) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(c); }
    else if (e.key === 'Delete') { e.preventDefault(); remove(c.dataset.id); }
    else if (e.key === 'F2') { e.preventDefault(); startRename(c.dataset.id, c.querySelector('.dl-title')); }
  });
  listEl.addEventListener('contextmenu', (e) => {
    const c = cardOf(e);
    if (!c) return;
    e.preventDefault();
    const id = c.dataset.id;
    emw.menu(e.clientX, e.clientY, [
      { label: 'Restore', run: () => restore(id) },
      { label: 'Rename', run: () => startRename(id, c.querySelector('.dl-title')) },
      null,
      { label: 'Delete', danger: true, run: () => remove(id) }
    ]);
  });
  // Double-clicking the preview's title renames too.
  $('#dl-preview').addEventListener('dblclick', (e) => {
    const t = e.target.closest('.dl-pt');
    if (t && sel) startRename(sel, t);
  });

  // ---- wiring ---------------------------------------------------------------------------------------------
  emw.snapshots = { cards, total: () => items.length, countText, selected: () => sel, select, renderPreview, refresh, restore, auto, list: () => items.slice() };
  // `save` is now "save and snapshot". Code that only needs pending text written calls emw.actions.flush.
  emw.actions.save = () => saveSnapshot();
  emw.actions.saveSnapshotAs = saveNamed;
  emw.keys.register({ id: 'saveSnapshotAs', label: 'Save snapshot with a name…', group: 'File', keys: 'Ctrl+Shift+S', when: () => !document.querySelector('dialog[open]') });

  emw.onView((name) => { if (name === 'darlings') refresh(); });
  // A different book (or the same one reloaded after a restore): the old list means nothing there.
  emw.book.onSwitch((id) => {
    items = [];
    sel = '';
    version++;
    outlineToken++;
    if (id && emw.view() === 'darlings') refresh();
  });
})();
