// Home: the screen the app opens on. Books sit on shelves; a click opens one.
//
// The library (shelves, order, colours) lives in library.json in the main process. This file keeps
// a working copy of it, writes it back after every change, and re-reads it each time Home is shown
// so word counts and "last edited" are fresh. Opening a book goes through emw.book (book.js).
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const root = document.getElementById('view-home');

  let lib = null;          // { shelves: [{id, name, books[]}], books: Map<id, book> }
  let lastId = null;       // the book that was open last time ("Continue writing")
  let loadError = '';
  let drag = null;         // { id } of the cover being dragged
  let writing = Promise.resolve();
  const covers = new Map();   // bookId -> data URL, or null when it has none

  // ---- small helpers ------------------------------------------------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const icon = (name) => {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'ic');
    const use = document.createElementNS(SVGNS, 'use');
    use.setAttribute('href', '#' + name);
    svg.append(use);
    return svg;
  };
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const shelf = (id) => (lib ? lib.shelves.find((s) => s.id === id) : null);
  const penName = () => String(emw.settings.get('penName') || '').trim();
  const trashName = () => (/Win/.test(navigator.platform) ? 'Recycle Bin' : 'Trash');

  // A calm colour for books that have not been given one, the same every time for the same book.
  function hslHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const x = (v) => Math.round(255 * v).toString(16).padStart(2, '0');
    return '#' + x(f(0)) + x(f(8)) + x(f(4));
  }
  function bookColour(b) {
    if (b.color) return b.color;
    let h = 0;
    for (const ch of b.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return hslHex(h, 38, 64);
  }

  function greeting() {
    const h = new Date().getHours();
    const part = h >= 4 && h < 12 ? 'Good morning' : h >= 12 && h < 18 ? 'Good afternoon' : 'Good evening';
    const name = penName();
    const g = el('h1', 'home-greet', part);
    if (name) { g.append(document.createTextNode(', ')); g.append(el('em', null, name)); }
    return g;
  }

  // ---- loading and saving the library ----------------------------------------------------------
  async function refresh() {
    await writing;   // never read while our own change is still on its way to disk
    try {
      const l = await window.api.getLibrary();
      lib = {
        shelves: l.shelves.map((s) => ({ id: s.id, name: s.name, books: [...s.books] })),
        books: new Map(l.books.map((b) => [b.id, b]))
      };
      loadError = '';
      for (const id of [...covers.keys()]) if (!lib.books.get(id) || !lib.books.get(id).hasCover) covers.delete(id);
      // Reported once, by the main process, after the library moved into its new folder.
      if (l.migrationNotice) emw.toast(l.migrationNotice, { ms: 12000 });
    } catch (err) {
      loadError = (err && err.message ? String(err.message) : '').replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
        || 'Could not read your library.';
    }
    try { lastId = (await window.api.getSettings()).lastBookId || null; } catch { lastId = null; }
  }

  function saveLib() {
    if (!lib) return writing;
    const bookMeta = {};
    for (const b of lib.books.values()) if (b.color) bookMeta[b.id] = { color: b.color };
    const payload = { shelves: lib.shelves.map((s) => ({ id: s.id, name: s.name, books: [...s.books] })), bookMeta };
    writing = writing.catch(() => {}).then(() => window.api.writeLibrary(payload))
      .catch(() => { emw.toast('Could not save your shelves. They may be back as they were next time.'); });
    return writing;
  }

  async function loadCover(id) {
    if (covers.has(id)) return;
    covers.set(id, null);   // mark as in flight so render() does not ask twice
    try {
      const url = await window.api.getCover(id);
      covers.set(id, typeof url === 'string' ? url : null);
    } catch { covers.set(id, null); }
    if (emw.view() === 'home') render();
  }

  // ---- drawing -----------------------------------------------------------------------------------
  function coverEl(b) {
    const c = el('div', 'cover');
    c.dataset.id = b.id;
    c.tabIndex = -1;
    c.draggable = true;
    c.setAttribute('role', 'button');
    c.style.setProperty('--bc', bookColour(b));
    const isLast = b.id === lastId && !b.newerFormat;
    if (isLast) c.classList.add('continue');
    if (b.newerFormat) c.classList.add('locked');
    const edited = fmtDate(b.edited);
    c.setAttribute('aria-label', [b.title, isLast ? 'continue writing' : '', b.newerFormat ? 'needs a newer enWriter' : `${plural(b.words || 0, 'word')}`, edited ? `last edited ${edited}` : ''].filter(Boolean).join(', '));

    const url = covers.get(b.id);
    if (url) {
      c.classList.add('has-img');
      const img = el('img', 'cv-img');
      img.alt = '';
      img.draggable = false;
      img.src = url;
      c.append(img);
    } else if (b.hasCover && !covers.has(b.id)) {
      loadCover(b.id);
    }

    const text = el('div', 'cv-text');
    text.append(el('div', 'cv-title', b.title));
    const pen = penName();
    if (pen) text.append(el('div', 'cv-pen', pen));
    c.append(text);

    const hover = el('div', 'cv-hover');
    if (b.newerFormat) hover.append(el('span', null, 'Needs a newer enWriter'));
    else {
      hover.append(el('span', null, plural(b.words || 0, 'word')));
      if (edited) hover.append(el('span', 'cv-date', `Edited ${edited}`));
    }
    c.append(hover);

    if (isLast) c.append(el('span', 'cv-tag', 'Continue writing'));
    return c;
  }

  function shelfEl(sh) {
    const sec = el('section', 'shelf');
    sec.dataset.id = sh.id;
    sec.setAttribute('aria-label', `Shelf: ${sh.name}`);

    const head = el('header', 'shelf-head');
    const name = el('h2', 'shelf-name', sh.name);
    name.title = 'Double-click to rename';
    const k = el('button', 'kebab', '⋯');
    k.type = 'button';
    k.setAttribute('aria-label', `Options for shelf ${sh.name}`);
    k.setAttribute('aria-haspopup', 'menu');
    head.append(name, k);

    const row = el('div', 'shelf-row');
    row.dataset.shelf = sh.id;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', sh.name);
    for (const id of sh.books) {
      const b = lib.books.get(id);
      if (b) row.append(coverEl(b));
    }
    const slot = el('button', 'cover-slot');
    slot.type = 'button';
    slot.tabIndex = -1;
    slot.title = 'New book on this shelf';
    slot.setAttribute('aria-label', `New book on shelf ${sh.name}`);
    slot.append(icon('i-plus'));
    row.append(slot);

    sec.append(head, row);
    return sec;
  }

  function cells() { return [...root.querySelectorAll('.cover, .cover-slot')]; }

  function render() {
    // Keep the keyboard position across a redraw.
    const a = document.activeElement;
    const keep = a && root.contains(a)
      ? (a.dataset.id ? { id: a.dataset.id } : (a.classList.contains('cover-slot') ? { slot: a.closest('.shelf').dataset.id } : null))
      : null;

    root.replaceChildren();
    const head = el('div', 'home-head');
    head.append(greeting());
    if (lib) {
      const last = lastId && lib.books.get(lastId);
      if (last && !last.newerFormat) {
        const b = el('button', 'home-continue');
        b.type = 'button';
        b.append(el('span', 'lbl', 'Continue writing'), el('b', null, last.title));
        head.append(b);
      }
    }
    root.append(head);

    if (!lib) {
      root.append(el('p', 'home-error', loadError || 'Loading your library…'));
      return;
    }
    if (loadError) root.append(el('p', 'home-error', loadError));

    const shelves = el('div', 'shelves');
    for (const sh of lib.shelves) shelves.append(shelfEl(sh));
    const add = el('button', 'shelf-new', '+ New shelf');
    add.type = 'button';
    root.append(shelves, add);

    // One tab stop for the whole grid; arrow keys do the rest.
    const all = cells();
    let stop = null;
    if (keep && keep.id) stop = all.find((c) => c.dataset.id === keep.id);
    else if (keep && keep.slot) stop = root.querySelector(`.shelf[data-id="${keep.slot}"] .cover-slot`);
    stop = stop || root.querySelector('.cover.continue') || all[0];
    for (const c of all) c.tabIndex = c === stop ? 0 : -1;
    if (keep && stop) stop.focus({ preventScroll: true });
  }

  // ---- opening and creating -----------------------------------------------------------------------
  async function openBook(id) {
    const b = lib && lib.books.get(id);
    if (!b) return;
    if (b.newerFormat) {
      emw.toast(`“${b.title}” was made by a newer version of enWriter. Update enWriter to open it.`, { ms: 8000 });
      return;
    }
    if (emw.book.id !== id && !(await emw.book.open(id))) return;
    lastId = id;
    emw.showView('manuscript');
  }

  const focusedShelfId = () => {
    const s = document.activeElement && document.activeElement.closest ? document.activeElement.closest('#view-home .shelf') : null;
    return (s && s.dataset.id) || (lib && lib.shelves[0] && lib.shelves[0].id) || null;
  };

  async function newBook(shelfId) {
    if (emw.view() !== 'home') emw.showView('home');
    if (!lib) await refresh();
    if (!lib) return;
    const title = await emw.ask({ message: 'Title of the new book', input: '', okLabel: 'Create' });
    if (title === null) return;
    let made;
    try { made = await window.api.createBook(title.trim() || 'Untitled Novel'); }
    catch { emw.toast('Could not create the book. Nothing was changed.'); return; }
    await refresh();
    // The main process puts a new book on the first shelf; move it to the shelf it was made on.
    const target = shelf(shelfId) || lib.shelves[0];
    for (const s of lib.shelves) s.books = s.books.filter((id) => id !== made.id);
    target.books.push(made.id);
    saveLib();
    render();
    const c = root.querySelector(`.cover[data-id="${made.id}"]`);
    if (c) { c.tabIndex = 0; c.focus(); c.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  // ---- moving books -------------------------------------------------------------------------------
  function moveBook(id, shelfId, index) {
    const target = shelf(shelfId);
    if (!target) return;
    const from = lib.shelves.find((s) => s.books.includes(id));
    let at = index;
    if (from) {
      const i = from.books.indexOf(id);
      from.books.splice(i, 1);
      if (from === target && i < at) at--;   // removing it shifted everything after it
    }
    target.books.splice(Math.max(0, Math.min(at, target.books.length)), 0, id);
    saveLib();
    render();
  }

  // ---- shelves --------------------------------------------------------------------------------------
  function renameShelf(id) {
    const sh = shelf(id);
    const nameEl = root.querySelector(`.shelf[data-id="${id}"] .shelf-name`);
    if (!sh || !nameEl) return;
    emw.rename(nameEl, {
      value: sh.name,
      placeholder: 'Shelf name',
      onCommit: (v) => { if (v && v !== sh.name) { sh.name = v.slice(0, 100); saveLib(); } },
      onDone: render
    });
  }

  function newShelf() {
    const id = S.uid();
    lib.shelves.push({ id, name: `Shelf ${lib.shelves.length + 1}`, books: [] });
    saveLib();
    render();
    const s = root.querySelector(`.shelf[data-id="${id}"]`);
    if (s) { s.scrollIntoView({ block: 'nearest' }); renameShelf(id); }
  }

  function moveShelf(id, delta) {
    const i = lib.shelves.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= lib.shelves.length) return;
    [lib.shelves[i], lib.shelves[j]] = [lib.shelves[j], lib.shelves[i]];
    saveLib();
    render();
  }

  function deleteShelf(id) {
    if (lib.shelves.length <= 1) { emw.toast('Keep at least one shelf'); return; }
    const snapshot = clone(lib.shelves);
    const i = lib.shelves.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [gone] = lib.shelves.splice(i, 1);
    const home = lib.shelves[0];   // the first shelf that is left
    home.books.push(...gone.books);
    saveLib();
    render();
    emw.toast(`Deleted the shelf “${gone.name}”. Its books moved to “${home.name}”.`, {
      action: { label: 'Undo', run: () => { lib.shelves = snapshot; saveLib(); render(); } }
    });
  }

  function shelfMenu(id, x, y) {
    const i = lib.shelves.findIndex((s) => s.id === id);
    emw.menu(x, y, [
      { label: 'Rename', run: () => renameShelf(id) },
      { label: 'Move up', disabled: i <= 0, run: () => moveShelf(id, -1) },
      { label: 'Move down', disabled: i >= lib.shelves.length - 1, run: () => moveShelf(id, 1) },
      null,
      { label: 'Delete shelf', danger: true, disabled: lib.shelves.length <= 1, run: () => deleteShelf(id) }
    ]);
  }

  // ---- one book's actions ----------------------------------------------------------------------------
  async function renameBook(id) {
    const b = lib.books.get(id);
    if (!b || b.newerFormat) return;
    const title = await emw.ask({ message: 'Rename book', input: b.title, okLabel: 'Rename' });
    if (title === null || !title.trim() || title.trim() === b.title) return;
    try {
      // Write the open book's pending changes first, so the rename cannot be overwritten by them.
      if (emw.book.id === id) await emw.actions.save();
      await window.api.renameBook(id, title.trim());
      if (emw.book.id === id) emw.book.renamed(title.trim().slice(0, 200));
    } catch (err) {
      emw.toast((err && err.message ? String(err.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : '') || 'Could not rename the book.');
    }
    await refresh();
    render();
  }

  function pickColour(initial) {
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'color';
      i.value = initial;
      i.className = 'home-colour-input';
      i.tabIndex = -1;
      i.setAttribute('aria-hidden', 'true');
      document.body.append(i);
      let done = false;
      const end = (v) => { if (done) return; done = true; i.remove(); resolve(v); };
      i.addEventListener('change', () => end(i.value));
      i.addEventListener('cancel', () => end(null));
      i.click();
    });
  }

  function pickImage() {
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'file';
      i.accept = 'image/*';
      i.hidden = true;
      document.body.append(i);
      let done = false;
      const end = (v) => { if (done) return; done = true; i.remove(); resolve(v); };
      i.addEventListener('change', () => end(i.files && i.files[0] ? i.files[0] : null));
      i.addEventListener('cancel', () => end(null));
      i.click();
    });
  }

  async function changeColour(id) {
    const b = lib.books.get(id);
    const c = await pickColour(bookColour(b));
    if (!c) return;
    b.color = c;
    saveLib();
    render();
  }

  async function setCover(id) {
    const b = lib.books.get(id);
    if (!b || b.newerFormat) return;
    const file = await pickImage();
    if (!file) return;
    try {
      const url = await emw.imageToDataUrl(file, 480);
      await window.api.setCover(id, url);
      b.hasCover = true;
      covers.set(id, url);
    } catch (err) {
      emw.toast(err && err.message && /not an image/.test(err.message) ? 'That file is not an image.' : 'Could not set the cover image.');
    }
    render();
  }

  async function removeCover(id) {
    try { await window.api.setCover(id, null); lib.books.get(id).hasCover = false; covers.delete(id); }
    catch { emw.toast('Could not remove the cover image.'); }
    render();
  }

  async function trashBook(id) {
    const b = lib.books.get(id);
    if (!b) return;
    try {
      // Leave it first, so its pending changes are saved and nothing writes to it afterwards.
      if (emw.book.id === id) await emw.book.close();
      await window.api.deleteBook(id);
    } catch {
      emw.toast('Could not move that book to the trash. Nothing was deleted.');
      await refresh();
      render();
      return;
    }
    covers.delete(id);
    await refresh();
    render();
    // No Undo: the package is in the OS trash, and that is where it is restored from.
    emw.toast(`Moved “${b.title}” to the ${trashName()}. Restore it from there if you want it back.`, { ms: 9000 });
  }

  function bookMenu(id, x, y) {
    const b = lib.books.get(id);
    if (!b) return;
    const items = [
      { label: 'Open', run: () => openBook(id) },
      { label: 'Rename', disabled: b.newerFormat, run: () => renameBook(id) },
      { label: 'Change colour', run: () => changeColour(id) },
      { label: 'Set cover image', disabled: b.newerFormat, run: () => setCover(id) }
    ];
    if (b.hasCover) items.push({ label: 'Remove cover image', run: () => removeCover(id) });
    items.push(
      { label: 'Move to shelf ▸', disabled: lib.shelves.length < 2, run: () => {
        const from = lib.shelves.find((s) => s.books.includes(id));
        emw.menu(x, y, lib.shelves.map((s) => ({
          label: s.name,
          disabled: from === s,
          run: () => moveBook(id, s.id, s.books.length)
        })));
      } },
      { label: 'Show in folder', run: () => { window.api.revealBook(id).catch(() => emw.toast('Could not show that folder.')); } },
      null,
      { label: 'Delete', danger: true, run: () => trashBook(id) }
    );
    emw.menu(x, y, items);
  }

  // ---- events (delegated: the children are replaced on every render) --------------------------------
  root.addEventListener('click', (e) => {
    if (!lib) return;
    const k = e.target.closest('.kebab');
    if (k) {
      const r = k.getBoundingClientRect();
      shelfMenu(k.closest('.shelf').dataset.id, r.left, r.bottom + 2);
      return;
    }
    const cont = e.target.closest('.home-continue');
    if (cont) { if (lastId) openBook(lastId); return; }
    const slot = e.target.closest('.cover-slot');
    if (slot) { newBook(slot.closest('.shelf').dataset.id); return; }
    if (e.target.closest('.shelf-new')) { newShelf(); return; }
    const c = e.target.closest('.cover');
    if (c) openBook(c.dataset.id);
  });

  root.addEventListener('dblclick', (e) => {
    const n = e.target.closest('.shelf-name');
    if (n && lib) renameShelf(n.closest('.shelf').dataset.id);
  });

  root.addEventListener('contextmenu', (e) => {
    if (!lib) return;
    const c = e.target.closest('.cover');
    const sh = !c && e.target.closest('.shelf-head');
    if (!c && !sh) return;
    e.preventDefault();
    // From the keyboard the event has no pointer position; use the element instead.
    let x = e.clientX, y = e.clientY;
    if (!x && !y) { const r = (c || sh).getBoundingClientRect(); x = r.left + 8; y = r.bottom - 8; }
    if (c) bookMenu(c.dataset.id, x, y); else shelfMenu(sh.closest('.shelf').dataset.id, x, y);
  });

  root.addEventListener('focusin', (e) => {
    const c = e.target.closest('.cover, .cover-slot');
    if (!c) return;
    for (const o of cells()) o.tabIndex = o === c ? 0 : -1;
  });

  root.addEventListener('keydown', (e) => {
    if (emw.isTextField(e.target)) return;
    const cell = e.target.closest('.cover, .cover-slot');
    if (!cell || !lib) return;
    if (cell.classList.contains('cover') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openBook(cell.dataset.id);
      return;
    }
    const sec = cell.closest('.shelf');
    const row = [...sec.querySelectorAll('.cover, .cover-slot')];
    const i = row.indexOf(cell);
    let next = null;
    if (e.key === 'ArrowRight') next = row[Math.min(i + 1, row.length - 1)];
    else if (e.key === 'ArrowLeft') next = row[Math.max(i - 1, 0)];
    else if (e.key === 'Home') next = row[0];
    else if (e.key === 'End') next = row[row.length - 1];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const sibling = e.key === 'ArrowDown' ? sec.nextElementSibling : sec.previousElementSibling;
      if (sibling && sibling.classList.contains('shelf')) {
        const other = [...sibling.querySelectorAll('.cover, .cover-slot')];
        next = other[Math.min(i, other.length - 1)];
      }
    }
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  });

  // Ctrl+N on Home makes a book on the shelf that has focus (the first one otherwise).
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'n') return;
    if (emw.view() !== 'home' || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    newBook(focusedShelfId());
  });

  // ---- dragging covers between shelves -----------------------------------------------------------------
  const clearMarks = () => root.querySelectorAll('.drop-before, .drop-after, .drop-over')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-over'));

  function dropTarget(e) {
    const row = e.target.closest('.shelf-row');
    if (!drag || !row || !lib) return null;
    const sh = shelf(row.dataset.shelf);
    if (!sh) return null;
    const cov = e.target.closest('.cover');
    if (cov) {
      if (cov.dataset.id === drag.id) return null;
      const r = cov.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      return { mark: cov, cls: before ? 'drop-before' : 'drop-after', shelfId: sh.id, index: sh.books.indexOf(cov.dataset.id) + (before ? 0 : 1) };
    }
    return { mark: row, cls: 'drop-over', shelfId: sh.id, index: sh.books.length };   // empty space: the end
  }

  root.addEventListener('dragstart', (e) => {
    const c = e.target.closest ? e.target.closest('.cover') : null;
    if (!c || c !== e.target) return;
    drag = { id: c.dataset.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
    requestAnimationFrame(() => c.classList.add('dragging'));   // after the drag image is taken
  });
  root.addEventListener('dragover', (e) => {
    clearMarks();
    const t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    t.mark.classList.add(t.cls);
  });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) clearMarks(); });
  root.addEventListener('drop', (e) => {
    const t = dropTarget(e);
    clearMarks();
    if (!t) return;
    e.preventDefault();
    const id = drag.id;
    drag = null;
    moveBook(id, t.shelfId, t.index);
  });
  root.addEventListener('dragend', () => {
    drag = null;
    clearMarks();
    root.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  });

  // ---- wiring ------------------------------------------------------------------------------------------
  emw.onView(async (name) => {
    if (name !== 'home') return;
    // Save the open book first, so its word count and "last edited" are current on its cover.
    try { if (emw.book.id) await emw.actions.save(); } catch { /* ignore */ }
    await refresh();
    if (emw.view() === 'home') render();
  });
  emw.settings.onChange((key) => { if (key === 'penName' && emw.view() === 'home' && lib) render(); });

  emw.actions.newBook = () => newBook(focusedShelfId());
  emw.home = { refresh: async () => { await refresh(); if (emw.view() === 'home') render(); } };

  // Start: nothing is open. The store gets an empty placeholder so views never meet null.
  if (!S.data) S.load({});
  (async function init() {
    render();
    await refresh();
    if (emw.view() === 'home') render();
  })();
})();
