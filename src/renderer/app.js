// Manuscript: chapter and scene tree, inspector, autosave, word counts.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const emw = window.emw;
  const S = emw.store;
  const editor = emw.editor;

  const listEl = $('#chapters');
  const novelTitleEl = $('#novel-title');
  const chTitleEl = $('#ch-title');
  const synopsisEl = $('#ch-synopsis');
  const synLabelEl = $('#ch-synopsis-label');
  const contextEl = $('#in-context');
  const stWords = $('#st-words');
  const stTotal = $('#st-total');
  const stSave = $('#st-save');
  const inWords = $('#in-words');
  const inChars = $('#in-chars');
  const inRead = $('#in-read');
  const inScenes = $('#in-scenes');
  const centerEl = $('.center');
  const pageEl = $('#page');
  const detectedEl = $('#insp-detected');

  // Pause after the last keystroke before saving. Settings > Writing changes it (200 to 2000 ms).
  const saveDelay = () => {
    const v = emw.settings ? Number(emw.settings.get('autosaveDelay')) : 600;
    return v >= 200 && v <= 2000 ? v : 600;
  };

  let curId = null;          // id of the scene open in the editor (only scenes are writable)
  let curChapterId = null;   // id of the chapter whose overview is showing, when no scene is open
  let lastChapterId = null;  // the chapter we were last in, for choosing what to open after a delete
  let timer = 0;
  let dirtyText = false;
  let dirtyIndex = false;
  let chars = 0;
  // Part 7e: while a snapshot is restored, nothing may be written (see snapshots.js). Cleared by the caller once the book has been reloaded.
  let frozen = false;

  // Which chapters are folded in the tree. Kept per book, so it is read again on every switch.
  const collapsed = new Set();
  const loadCollapsed = () => {
    collapsed.clear();
    try { JSON.parse(localStorage.getItem(emw.book.key('collapsed')) || '[]').forEach((id) => collapsed.add(id)); } catch { /* ignore */ }
  };
  const saveCollapsed = () => { try { localStorage.setItem(emw.book.key('collapsed'), JSON.stringify([...collapsed])); } catch { /* ignore */ } };

  const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const chapterIndex = (ch) => S.data.chapters.indexOf(ch);
  const chapterLabel = (ch) => ch.title.trim() || `Chapter ${chapterIndex(ch) + 1}`;
  const sceneLabel = (s) => s.title.trim() || 'Untitled scene';
  const curDoc = () => (curId ? S.doc(curId) : null);                     // the scene in the editor
  const viewId = () => curId || curChapterId;                              // scene or chapter overview
  const viewDoc = () => { const id = viewId(); return id ? S.doc(id) : null; };
  const setSaveState = (t) => { stSave.textContent = t; };

  // ---- the chapter and scene tree --------------------------------------------
  function row(kind, item, chapter) {
    const li = document.createElement('li');
    li.className = kind;
    li.dataset.id = item.id;
    li.dataset.kind = kind;
    li.draggable = true;
    li.setAttribute('aria-current', String(item.id === viewId()));
    const name = document.createElement('span');
    name.className = 'name';
    const num = document.createElement('span');
    num.className = 'count';
    if (kind === 'chapter') {
      if (item.scenes.length) {
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'chev';
        chev.textContent = '›';
        chev.setAttribute('aria-label', 'Show or hide scenes');
        chev.setAttribute('aria-expanded', String(!collapsed.has(item.id)));
        li.append(chev);
      } else {
        const sp = document.createElement('span');
        sp.className = 'spacer';
        li.append(sp);
      }
      name.textContent = chapterLabel(item);
      num.textContent = S.chapterWords(item).toLocaleString();
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'add-scene';
      add.textContent = '+';
      add.title = 'Add a scene to this chapter';
      add.setAttribute('aria-label', 'Add a scene to this chapter');
      li.append(name, num, add);
    } else {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--c', item.color || S.find.plotline(item.plotline).color);
      name.textContent = sceneLabel(item);
      if (!item.title.trim()) name.classList.add('untitled');
      num.textContent = item.words.toLocaleString();
      li.append(dot, name, num);
    }
    return li;
  }

  function renderTree() {
    const frag = document.createDocumentFragment();
    for (const ch of S.data.chapters) {
      frag.append(row('chapter', ch));
      if (!collapsed.has(ch.id)) for (const s of ch.scenes) frag.append(row('scene', s, ch));
    }
    listEl.replaceChildren(frag);
  }

  function setTreeCount(id, n) {
    const c = listEl.querySelector(`li[data-id="${id}"] .count`);
    if (c) c.textContent = n.toLocaleString();
  }

  function startTreeRename(id) {
    emw.peek('hierarchy');
    const li = listEl.querySelector(`li[data-id="${id}"]`);
    const d = S.doc(id);
    if (!li || !d) return;
    emw.rename(li.querySelector('.name'), {
      value: d.item.title,
      placeholder: d.kind === 'chapter' ? `Chapter ${chapterIndex(d.item) + 1}` : 'Untitled scene',
      onCommit: (v) => (d.kind === 'chapter' ? S.updateChapter(id, { title: v }) : S.updateScene(id, { title: v })),
      onDone: renderTree
    });
  }

  // ---- inspector and counts -------------------------------------------------------
  function renderInspector(force = false) {
    const d = viewDoc();
    const set = (el, v) => { if (force || document.activeElement !== el) el.value = v; };
    if (!d) return;
    const isChapter = d.kind === 'chapter';
    // A chapter has no text, so "Detected in this text" and character count make no sense for it.
    detectedEl.hidden = isChapter;
    inChars.previousElementSibling.hidden = isChapter;
    inChars.hidden = isChapter;
    inScenes.previousElementSibling.hidden = !isChapter;
    inScenes.hidden = !isChapter;
    set(chTitleEl, d.item.title);
    chTitleEl.placeholder = isChapter ? `Chapter ${chapterIndex(d.item) + 1}` : 'Untitled scene';
    set(synopsisEl, isChapter ? d.item.synopsis : d.item.description);
    synLabelEl.textContent = isChapter ? 'Synopsis' : 'Description';
    contextEl.textContent = isChapter ? count(d.item.scenes.length, 'scene') : `Scene in ${chapterLabel(d.chapter)}`;
  }

  // The drop cap shows on the first paragraph of the chapter, wherever that paragraph lives.
  function syncDropcap() {
    const d = curDoc();
    if (!d) return;
    editor.syncDropcap(d.chapter.dropcap, S.dropcapOwner(d.chapter) === d.item.id);
  }

  function updateFooter() {
    if (!S.data) return;
    stTotal.textContent = `${count(S.totalWords(), 'word')} in manuscript`;
    if (emw.view() === 'timeline') {
      const scenes = S.data.chapters.reduce((n, c) => n + c.scenes.length, 0);
      stWords.textContent = `${count(S.data.chapters.length, 'chapter')}, ${count(scenes, 'scene')}`;
    } else if (curChapterId && !curId) {
      const ch = S.find.chapter(curChapterId);
      stWords.textContent = count(ch ? S.chapterWords(ch) : 0, 'word');
    } else {
      const d = curDoc();
      stWords.textContent = count(d ? d.item.words : 0, 'word');
    }
  }

  function updateCounts() {
    const d = viewDoc();
    if (!d) return;
    const words = d.kind === 'chapter' ? S.chapterWords(d.item) : d.item.words;   // a chapter is the sum of its scenes
    inWords.textContent = words.toLocaleString();
    inChars.textContent = chars.toLocaleString();
    inScenes.textContent = d.kind === 'chapter' ? d.item.scenes.length.toLocaleString() : '';
    inRead.textContent = words ? `${Math.max(1, Math.round(words / 230))} min` : '–';
    setTreeCount(d.item.id, words);
    if (d.kind === 'scene') setTreeCount(d.chapter.id, S.chapterWords(d.chapter));
    updateFooter();
  }

  function recount() {
    const text = editor.text();
    chars = text.replace(/\n/g, '').length;
    return S.setWords(curId, (text.match(/\S+/g) || []).length);
  }

  // ---- saving ---------------------------------------------------------------------
  async function flush() {
    clearTimeout(timer);
    if (frozen) return;
    // No book open (Home with nothing opened): there is nothing to write, and the main process
    // would refuse. Drop the flags so they cannot leak into the next book.
    if (!emw.book.id) { dirtyText = false; dirtyIndex = false; return; }
    const jobs = [];
    if (dirtyText && curId) { dirtyText = false; jobs.push(window.api.writeChapter(curId, editor.html())); }
    if (dirtyIndex) { dirtyIndex = false; jobs.push(window.api.writeIndex(S.data)); }
    if (jobs.length) {
      await Promise.all(jobs);
      setSaveState('Saved');
    }
  }

  // Typing stays instant; counting and disk work happen after a pause.
  function scheduleSave() {
    if (frozen) return;
    if (!dirtyText && !dirtyIndex) setSaveState('Saving…');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (dirtyText) { recount(); dirtyIndex = true; updateCounts(); syncDropcap(); }
      flush();
    }, saveDelay());
  }

  // ---- opening a chapter or scene ------------------------------------------------------
  // Which mode we are in decides whether the editor or the chapter overview is reachable at all.
  // The editor is made inert as well as hidden, so nothing can be typed into it from a chapter.
  function setChapterMode(on) {
    centerEl.classList.toggle('chapter-mode', on);
    pageEl.inert = on;
  }

  async function openChapter(id) {
    await flush();
    if (!S.find.chapter(id)) return;
    curId = null;
    curChapterId = id;
    lastChapterId = id;
    setChapterMode(true);
    renderTree();
    renderInspector(true);
    updateCounts();
    try { localStorage.setItem(emw.book.key('last'), id); } catch { /* ignore */ }
    document.dispatchEvent(new CustomEvent('emw:doc'));
  }

  async function openDoc(id) {
    if (S.find.chapter(id)) return openChapter(id);
    let html;
    do {
      await flush();
      html = await window.api.readChapter(id);
    } while (dirtyText);   // the person typed while the file was loading
    if (!S.doc(id)) return;
    curId = id;
    curChapterId = null;
    setChapterMode(false);
    editor.load(html);
    const d = S.doc(id);
    lastChapterId = d.chapter.id;
    if (collapsed.delete(d.chapter.id)) saveCollapsed();
    if (recount()) dirtyIndex = true;
    renderTree();
    renderInspector(true);
    updateCounts();
    syncDropcap();
    try { localStorage.setItem(emw.book.key('last'), id); } catch { /* ignore */ }
    editor.focus();
    document.dispatchEvent(new CustomEvent('emw:doc'));
  }

  // ---- actions --------------------------------------------------------------------------
  // A new chapter shows its (empty) overview and starts renaming; it never opens an editor.
  async function newChapter() {
    const d = viewDoc();
    const id = S.addChapter(d ? S.data.chapters.indexOf(d.chapter) + 1 : S.data.chapters.length);
    await openChapter(id);
    startTreeRename(id);
  }

  async function newScene(chapterId) {
    const d = viewDoc();
    const chId = typeof chapterId === 'string' ? chapterId : (d ? d.chapter.id : S.data.chapters[0].id);
    let plot = S.data.plotlines[0].id;
    if (d && d.kind === 'scene' && d.chapter.id === chId) plot = d.item.plotline;
    if (collapsed.delete(chId)) saveCollapsed();
    const id = S.addScene(chId, plot);
    await openDoc(id);
    startTreeRename(id);
  }

  function deleteDoc(id) {
    const d = S.doc(id);
    if (!d) return;
    const label = d.kind === 'chapter' ? chapterLabel(d.item) : sceneLabel(d.item);
    const ok = d.kind === 'chapter' ? S.deleteChapter(id) : S.deleteScene(id);
    if (ok === false) { emw.toast('A novel needs at least one chapter'); return; }
    emw.toast(`Deleted “${label}”`, { action: { label: 'Undo', run: () => { S.undo(); } } });
  }

  async function duplicateScene(id) {
    await flush();
    const newId = S.duplicateScene(id);
    if (!newId) return null;
    const html = await window.api.readChapter(id);
    if (html) await window.api.writeChapter(newId, html);
    emw.toast('Scene duplicated');
    return newId;
  }

  function undoStructure() {
    const label = S.undo();
    emw.toast(label ? `Undid: ${label}` : 'Nothing to undo', { ms: 2200 });
  }
  function redoStructure() {
    const label = S.redo();
    emw.toast(label ? `Redid: ${label}` : 'Nothing to redo', { ms: 2200 });
  }

  emw.freezeSave = (on) => { frozen = !!on; if (frozen) clearTimeout(timer); };
  emw.setSaveState = setSaveState;
  // A short-lived status ("Snapshot saved"): goes back to "Saved" after two seconds unless something else was shown since.
  let flashTimer = 0;
  emw.flashSaveState = (text, ms = 2000) => {
    setSaveState(text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (stSave.textContent === text) setSaveState('Saved'); }, ms);
  };
  emw.curDoc = viewDoc;                       // scene or chapter, for the inspector
  emw.curChapterId = () => (curId ? null : curChapterId);   // the chapter overview shows when set

  const textUndo = emw.actions.undo;
  const textRedo = emw.actions.redo;
  // Does Ctrl+Z mean store undo here? Decided by context, not by view name alone: the views that show
  // structure (Timeline, a chapter overview, Characters, Places, Notes, Tags, Darlings) use store undo,
  // unless focus is in a field with an undo of its own (a name, the filter box, the notes editor).
  // The Manuscript with a scene open stays text undo. Part 7d added the entity tabs and Darlings.
  const ENTITY_VIEWS = ['characters', 'places', 'notes', 'tags', 'darlings'];
  const structureUndoHere = (target) => {
    if (emw.isTextField(target || document.activeElement)) return false;
    const v = emw.view();
    if (v === 'timeline' || (v === 'manuscript' && !curId && !!curChapterId)) return true;
    // Behind a modal dialog (Settings, the scene dialog) the keys belong to the dialog.
    return ENTITY_VIEWS.includes(v) && !document.querySelector('dialog[open]');
  };

  Object.assign(emw.actions, {
    newChapter, newScene, save: flush, duplicateScene, undoStructure, redoStructure,
    flush,   // part 7e: `save` now also takes a snapshot (snapshots.js); code that only needs pending text written calls this
    undo: () => (structureUndoHere() ? undoStructure() : textUndo()),
    redo: () => (structureUndoHere() ? redoStructure() : textRedo()),
    deleteCurrent: () => deleteDoc(viewId()),
    deleteScene: deleteDoc,
    openScene: (id) => { emw.showView('manuscript'); openDoc(id); }
  });

  // ---- store changes (from the timeline, tree, inspector, or undo) ------------------------
  editor.onDropcapEdit = (patch) => {
    const d = curDoc();
    if (d) S.updateChapter(d.chapter.id, { dropcap: { ...d.chapter.dropcap, ...patch } }, { coalesce: `dropcap:${d.chapter.id}` });
  };

  // After the open item disappears: the first scene of the chapter we were in, else that chapter's
  // overview; if the chapter itself is gone, the first scene of the book, else the first overview.
  function openFallback() {
    const home = (lastChapterId && S.find.chapter(lastChapterId)) || null;
    if (home) return openDoc(home.scenes.length ? home.scenes[0].id : home.id);
    for (const ch of S.data.chapters) if (ch.scenes.length) return openDoc(ch.scenes[0].id);
    return openDoc(S.data.chapters[0].id);
  }

  S.on((info) => {
    if (!emw.book.id) return;   // the empty placeholder store is never saved or shown
    dirtyIndex = true;
    scheduleSave();
    if (info && info.quiet) return;
    if (curDoc()) {
      renderTree();
      renderInspector();
      syncDropcap();
    } else if (!curId && curChapterId && S.find.chapter(curChapterId)) {
      renderTree();
      renderInspector();
      updateCounts();
    } else if (S.data.chapters.length) {
      openFallback();   // the open scene or chapter was removed (deleted or undone)
    }
    updateFooter();
  });

  // ---- events ----------------------------------------------------------------------------
  editor.onChange(() => { dirtyText = true; scheduleSave(); });

  chTitleEl.addEventListener('input', () => {
    const d = viewDoc();
    if (!d) return;
    const id = viewId();
    const patch = { title: chTitleEl.value };
    const opts = { coalesce: `title:${id}` };
    if (d.kind === 'chapter') S.updateChapter(id, patch, opts); else S.updateScene(id, patch, opts);
  });

  synopsisEl.addEventListener('input', () => {
    const d = viewDoc();
    if (!d) return;
    const id = viewId();
    const opts = { coalesce: `syn:${id}` };
    if (d.kind === 'chapter') S.updateChapter(id, { synopsis: synopsisEl.value }, opts);
    else S.updateScene(id, { description: synopsisEl.value }, opts);
  });

  novelTitleEl.addEventListener('input', () => {
    S.data.title = novelTitleEl.value;
    dirtyIndex = true;
    scheduleSave();
  });

  $('#add').addEventListener('click', newChapter);

  listEl.addEventListener('click', (e) => {
    if (e.target.closest('.rename')) return;
    const li = e.target.closest('li');
    if (!li) return;
    if (e.target.closest('.chev')) {
      if (!collapsed.delete(li.dataset.id)) collapsed.add(li.dataset.id);
      saveCollapsed();
      renderTree();
      return;
    }
    if (e.target.closest('.add-scene')) { newScene(li.dataset.id); return; }
    if (li.dataset.id !== viewId()) openDoc(li.dataset.id);
  });

  listEl.addEventListener('dblclick', (e) => {
    const li = e.target.closest('li');
    if (li && e.target.closest('.name')) startTreeRename(li.dataset.id);
  });

  listEl.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li');
    if (!li || e.target.closest('.rename')) return;
    e.preventDefault();
    const id = li.dataset.id;
    const items = li.dataset.kind === 'chapter'
      ? [
        { label: 'Rename', run: () => startTreeRename(id) },
        { label: 'Add scene', run: () => newScene(id) },
        { label: 'Add chapter below', run: () => { const i = S.data.chapters.findIndex((c) => c.id === id); const nid = S.addChapter(i + 1); openDoc(nid).then(() => startTreeRename(nid)); } },
        null,
        { label: 'Send to Darlings', run: () => emw.darlings.send('chapter', id, { origin: 'manuscript' }) },
        { label: 'Delete chapter', danger: true, run: () => deleteDoc(id) }
      ]
      : [
        { label: 'Rename', run: () => startTreeRename(id) },
        { label: 'Show on timeline', run: () => { emw.showView('timeline'); } },
        { label: 'Duplicate', run: () => duplicateScene(id) },
        null,
        { label: 'Send to Darlings', run: () => emw.darlings.send('scene', id, { origin: 'manuscript' }) },
        { label: 'Delete scene', danger: true, run: () => deleteDoc(id) }
      ];
    emw.menu(e.clientX, e.clientY, items);
  });

  // Drag to reorder: chapters among chapters, scenes among scenes or into a chapter.
  let drag = null;
  const clearMarks = () => listEl.querySelectorAll('.drop-before, .drop-after, .drop-into')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
  const isBefore = (e, li) => { const r = li.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; };

  function listDrop(e) {
    const li = e.target.closest('li');
    if (!drag || !li || li.dataset.id === drag.id) return null;
    const before = isBefore(e, li);
    if (drag.kind === 'chapter') {
      if (li.dataset.kind !== 'chapter') return null;
      const at = S.data.chapters.findIndex((c) => c.id === li.dataset.id) + (before ? 0 : 1);
      return { li, cls: before ? 'drop-before' : 'drop-after', run: () => S.moveChapter(drag.id, at) };
    }
    if (li.dataset.kind === 'scene') {
      const f = S.find.scene(li.dataset.id);
      const at = f.chapter.scenes.indexOf(f.scene) + (before ? 0 : 1);
      return { li, cls: before ? 'drop-before' : 'drop-after', run: () => S.moveScene(drag.id, f.chapter.id, at) };
    }
    return { li, cls: 'drop-into', run: () => S.moveScene(drag.id, li.dataset.id) };
  }

  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('li');
    if (!li || li !== e.target) return;
    drag = { id: li.dataset.id, kind: li.dataset.kind };
    emw.dragItem = { kind: drag.kind, id: drag.id, origin: 'manuscript' };   // so the Darlings tab can take it
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
  });
  listEl.addEventListener('dragover', (e) => {
    clearMarks();
    const t = listDrop(e);
    if (!t) return;
    e.preventDefault();
    t.li.classList.add(t.cls);
  });
  listEl.addEventListener('drop', (e) => {
    const t = listDrop(e);
    clearMarks();
    if (!t) return;
    e.preventDefault();
    t.run();
  });
  listEl.addEventListener('dragend', () => { drag = null; emw.dragItem = null; clearMarks(); });

  // ---- keyboard ----------------------------------------------------------------------------
  // App-level shortcuts live in the registry (shortcuts.js); the writer can see and change them in Settings.
  const inManuscript = () => emw.view() === 'manuscript';
  // Ctrl+Z and Ctrl+Y are native text editing keys: they only mean "store undo" where structureUndoHere
  // says so (see above), outside text boxes. Any key the writer adds to Undo or Redo works everywhere.
  const storeUndoHere = (e, combo) => !emw.keys.isNative(combo) || structureUndoHere(e.target);
  emw.keys.register({ id: 'save', label: 'Save and snapshot', group: 'File', keys: 'Ctrl+S' });
  emw.keys.register({ id: 'newChapter', label: 'New chapter', group: 'File', keys: 'Ctrl+N', when: inManuscript, scope: 'manuscript' });
  emw.keys.register({ id: 'newScene', label: 'New scene', group: 'File', keys: 'Ctrl+Shift+N', when: inManuscript });
  emw.keys.register({ id: 'undo', label: 'Undo', group: 'Edit', keys: 'Ctrl+Z', when: storeUndoHere });
  emw.keys.register({ id: 'redo', label: 'Redo', group: 'Edit', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], when: storeUndoHere });
  emw.keys.register({ id: 'undoStructure', label: 'Undo chapter or scene change', group: 'Edit', keys: 'Ctrl+Alt+Z' });
  emw.keys.register({ id: 'redoStructure', label: 'Redo chapter or scene change', group: 'Edit', keys: 'Ctrl+Alt+Shift+Z' });
  emw.keys.register({ id: 'toggleHierarchy', label: 'Pin chapters panel', group: 'View', keys: 'Alt+1' });
  emw.keys.register({ id: 'toggleRibbon', label: 'Show ribbon', group: 'View', keys: 'Alt+2' });
  emw.keys.register({ id: 'toggleInspector', label: 'Pin inspector', group: 'View', keys: 'Alt+3' });

  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.api.onBeforeClose(async () => { await flush(); emw.flushHooks.forEach((f) => f()); await new Promise((r) => setTimeout(r, 60)); window.api.closeReady(); });
  emw.onView(updateFooter);

  // ---- one-time upgrade: chapter text becomes a first scene ---------------------------------
  // Order matters so no text is ever lost: copy into the new scene files first, and only then
  // save the index that points at them. The old chapter file is left on disk as a backup.
  async function migrateChapterText() {
    const todo = S.migrationCandidates();
    if (!todo) return;
    try {
      const items = [];
      for (const { id, words } of todo) {
        const html = await window.api.readChapter(id);
        if (html.trim() || words > 0) items.push({ chapterId: id, html });
      }
      const made = S.migrateChapters(items);
      await Promise.all(made.map((m) => window.api.writeChapter(m.sceneId, m.html)));
      await window.api.writeIndex(S.data);
    } catch {
      // Nothing was saved, so the old files are intact: reload them and try again next launch.
      S.load(await window.api.loadNovel());
      emw.toast('Could not upgrade your chapters yet. Your text is untouched.');
    }
  }

  // ---- start ---------------------------------------------------------------------------------
  // Runs after the store was reset for a different book (or emptied, when id is null).
  // Everything this file remembers about the previous book is dropped first.
  async function startBook(bookId) {
    clearTimeout(timer);
    dirtyText = false;
    dirtyIndex = false;
    curId = null;
    curChapterId = null;
    lastChapterId = null;
    chars = 0;
    editor.load('');
    setChapterMode(false);
    loadCollapsed();
    setSaveState('Saved');
    if (!bookId) { listEl.replaceChildren(); novelTitleEl.value = ''; return; }
    await migrateChapterText();
    novelTitleEl.value = S.data.title;
    let last = '';
    try { last = localStorage.getItem(emw.book.key('last')) || ''; } catch { /* ignore */ }
    if (S.doc(last)) await openDoc(last); else await openFallback();
    // Only write back when loading actually changed something (an upgrade, a repaired count).
    // Opening a book must not touch its "last edited" date.
    if (emw.book.upgraded) dirtyIndex = true;
    if (dirtyIndex) scheduleSave();
  }
  emw.book.onSwitch(startBook);
})();
