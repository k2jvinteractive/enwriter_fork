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

  const SAVE_DELAY_MS = 600;
  const LAST_KEY = 'emwriter.last';
  const COLLAPSE_KEY = 'emwriter.collapsed';

  let curId = null;   // id of the chapter or scene open in the editor
  let timer = 0;
  let dirtyText = false;
  let dirtyIndex = false;
  let chars = 0;

  const collapsed = new Set();
  try { JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]').forEach((id) => collapsed.add(id)); } catch { /* ignore */ }
  const saveCollapsed = () => { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* ignore */ } };

  const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const chapterIndex = (ch) => S.data.chapters.indexOf(ch);
  const chapterLabel = (ch) => ch.title.trim() || `Chapter ${chapterIndex(ch) + 1}`;
  const sceneLabel = (s) => s.title.trim() || 'Untitled scene';
  const curDoc = () => (curId ? S.doc(curId) : null);
  const setSaveState = (t) => { stSave.textContent = t; };

  // ---- the chapter and scene tree --------------------------------------------
  function row(kind, item, chapter) {
    const li = document.createElement('li');
    li.className = kind;
    li.dataset.id = item.id;
    li.dataset.kind = kind;
    li.draggable = true;
    li.setAttribute('aria-current', String(item.id === curId));
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
    const d = curDoc();
    const set = (el, v) => { if (force || document.activeElement !== el) el.value = v; };
    if (!d) return;
    const isChapter = d.kind === 'chapter';
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
    } else {
      const d = curDoc();
      stWords.textContent = count(d ? d.item.words : 0, 'word');
    }
  }

  function updateCounts() {
    const d = curDoc();
    if (!d) return;
    inWords.textContent = d.item.words.toLocaleString();
    inChars.textContent = chars.toLocaleString();
    inRead.textContent = d.item.words ? `${Math.max(1, Math.round(d.item.words / 230))} min` : '–';
    setTreeCount(d.item.id, d.kind === 'chapter' ? S.chapterWords(d.item) : d.item.words);
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
    if (!curId) return;
    const jobs = [];
    if (dirtyText) { dirtyText = false; jobs.push(window.api.writeChapter(curId, editor.html())); }
    if (dirtyIndex) { dirtyIndex = false; jobs.push(window.api.writeIndex(S.data)); }
    if (jobs.length) {
      await Promise.all(jobs);
      setSaveState('Saved');
    }
  }

  // Typing stays instant; counting and disk work happen after a pause.
  function scheduleSave() {
    if (!dirtyText && !dirtyIndex) setSaveState('Saving…');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (dirtyText) { recount(); dirtyIndex = true; updateCounts(); syncDropcap(); }
      flush();
    }, SAVE_DELAY_MS);
  }

  // ---- opening a chapter or scene ------------------------------------------------------
  async function openDoc(id) {
    let html;
    do {
      await flush();
      html = await window.api.readChapter(id);
    } while (dirtyText);   // the person typed while the file was loading
    if (!S.doc(id)) return;
    curId = id;
    editor.load(html);
    const d = S.doc(id);
    if (d.kind === 'scene' && collapsed.delete(d.chapter.id)) saveCollapsed();
    if (recount()) dirtyIndex = true;
    renderTree();
    renderInspector(true);
    updateCounts();
    syncDropcap();
    try { localStorage.setItem(LAST_KEY, id); } catch { /* ignore */ }
    editor.focus();
    document.dispatchEvent(new CustomEvent('emw:doc'));
  }

  // ---- actions --------------------------------------------------------------------------
  async function newChapter() {
    const d = curDoc();
    const id = S.addChapter(d ? S.data.chapters.indexOf(d.chapter) + 1 : S.data.chapters.length);
    await openDoc(id);
    startTreeRename(id);
  }

  async function newScene(chapterId) {
    const d = curDoc();
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

  emw.curDoc = curDoc;

  const textUndo = emw.actions.undo;
  const textRedo = emw.actions.redo;
  const onTimeline = () => emw.view() === 'timeline' && !emw.isTextField(document.activeElement);

  Object.assign(emw.actions, {
    newChapter, newScene, save: flush, duplicateScene, undoStructure, redoStructure,
    undo: () => (onTimeline() ? undoStructure() : textUndo()),
    redo: () => (onTimeline() ? redoStructure() : textRedo()),
    deleteCurrent: () => deleteDoc(curId),
    deleteScene: deleteDoc,
    openScene: (id) => { emw.showView('manuscript'); openDoc(id); }
  });

  // ---- store changes (from the timeline, tree, inspector, or undo) ------------------------
  editor.onDropcapEdit = (patch) => {
    const d = curDoc();
    if (d) S.updateChapter(d.chapter.id, { dropcap: { ...d.chapter.dropcap, ...patch } }, { coalesce: `dropcap:${d.chapter.id}` });
  };

  S.on((info) => {
    dirtyIndex = true;
    scheduleSave();
    if (info && info.quiet) return;
    if (curDoc()) {
      renderTree();
      renderInspector();
      syncDropcap();
    } else if (S.data.chapters.length) {
      openDoc(S.data.chapters[0].id);   // the open item was removed (deleted or undone)
    }
    updateFooter();
  });

  // ---- events ----------------------------------------------------------------------------
  editor.onChange(() => { dirtyText = true; scheduleSave(); });

  chTitleEl.addEventListener('input', () => {
    const d = curDoc();
    if (!d) return;
    const patch = { title: chTitleEl.value };
    const opts = { coalesce: `title:${curId}` };
    if (d.kind === 'chapter') S.updateChapter(curId, patch, opts); else S.updateScene(curId, patch, opts);
  });

  synopsisEl.addEventListener('input', () => {
    const d = curDoc();
    if (!d) return;
    const opts = { coalesce: `syn:${curId}` };
    if (d.kind === 'chapter') S.updateChapter(curId, { synopsis: synopsisEl.value }, opts);
    else S.updateScene(curId, { description: synopsisEl.value }, opts);
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
    if (li.dataset.id !== curId) openDoc(li.dataset.id);
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
        { label: 'Delete chapter', danger: true, run: () => deleteDoc(id) }
      ]
      : [
        { label: 'Rename', run: () => startTreeRename(id) },
        { label: 'Show on timeline', run: () => { emw.showView('timeline'); } },
        { label: 'Duplicate', run: () => duplicateScene(id) },
        null,
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
  listEl.addEventListener('dragend', () => { drag = null; clearMarks(); });

  // ---- keyboard ----------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 's') { e.preventDefault(); flush(); }
    else if (mod && !e.altKey && key === 'n' && emw.view() === 'manuscript') {
      e.preventDefault();
      if (e.shiftKey) newScene(); else newChapter();
    } else if (mod && e.altKey && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoStructure(); else undoStructure();
    } else if (mod && !e.altKey && (key === 'z' || key === 'y') && emw.view() === 'timeline' && !emw.isTextField(e.target)) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) redoStructure(); else undoStructure();
    } else if (e.altKey && !mod) {
      const action = { Digit1: 'toggleHierarchy', Digit2: 'toggleRibbon', Digit3: 'toggleInspector' }[e.code];
      if (action) { e.preventDefault(); emw.actions[action](); }
    }
  });

  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.api.onBeforeClose(async () => { await flush(); emw.flushHooks.forEach((f) => f()); await new Promise((r) => setTimeout(r, 60)); window.api.closeReady(); });
  emw.onView(updateFooter);

  // ---- start ---------------------------------------------------------------------------------
  (async function init() {
    S.load(await window.api.loadNovel());
    novelTitleEl.value = S.data.title;
    let last = '';
    try { last = localStorage.getItem(LAST_KEY) || ''; } catch { /* ignore */ }
    await openDoc(S.doc(last) ? last : S.data.chapters[0].id);
    dirtyIndex = true;   // persist any upgrade to the new chapter and scene format
    scheduleSave();
  })();
})();
