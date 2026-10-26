// Chapters, inspector, autosave and word counts.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const emw = window.emw;
  const editor = emw.editor;

  const listEl = $('#chapters');
  const novelTitleEl = $('#novel-title');
  const chTitleEl = $('#ch-title');
  const synopsisEl = $('#ch-synopsis');
  const stWords = $('#st-words');
  const stTotal = $('#st-total');
  const stSave = $('#st-save');
  const inWords = $('#in-words');
  const inChars = $('#in-chars');
  const inRead = $('#in-read');

  const SAVE_DELAY_MS = 600;
  const LAST_KEY = 'emwriter.last';

  let index = null;     // { title, chapters: [{ id, title, words, synopsis }] }
  let current = null;   // the chapter being edited
  let timer = 0;
  let dirtyText = false;
  let dirtyIndex = false;
  let chars = 0;

  const plural = (n) => `${n.toLocaleString()} ${n === 1 ? 'word' : 'words'}`;
  const label = (c) => c.title.trim() || 'Untitled chapter';
  const activeRow = () => listEl.querySelector('[aria-current="true"]');
  const setSaveState = (t) => { stSave.textContent = t; };

  // ---- rendering -----------------------------------------------------------
  function renderList() {
    const frag = document.createDocumentFragment();
    for (const ch of index.chapters) {
      const li = document.createElement('li');
      li.dataset.id = ch.id;
      li.draggable = true;
      li.setAttribute('aria-current', String(ch === current));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = label(ch);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = ch.words.toLocaleString();
      li.append(name, count);
      frag.append(li);
    }
    listEl.replaceChildren(frag);
  }

  function updateCounts() {
    const total = index.chapters.reduce((sum, c) => sum + c.words, 0);
    stWords.textContent = plural(current.words);
    stTotal.textContent = `${plural(total)} in manuscript`;
    inWords.textContent = current.words.toLocaleString();
    inChars.textContent = chars.toLocaleString();
    inRead.textContent = current.words ? `${Math.max(1, Math.round(current.words / 230))} min` : '–';
    const row = activeRow();
    if (row) row.querySelector('.count').textContent = current.words.toLocaleString();
  }

  function recount() {
    const text = editor.text();
    current.words = (text.match(/\S+/g) || []).length;
    chars = text.replace(/\n/g, '').length;
  }

  // ---- saving --------------------------------------------------------------
  async function flush() {
    clearTimeout(timer);
    if (!current) return;
    const jobs = [];
    if (dirtyText) { dirtyText = false; jobs.push(window.api.writeChapter(current.id, editor.html())); }
    if (dirtyIndex) { dirtyIndex = false; jobs.push(window.api.writeIndex(index)); }
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
      if (dirtyText) {
        recount();
        dirtyIndex = true;
        updateCounts();
      }
      flush();
    }, SAVE_DELAY_MS);
  }

  // ---- chapter actions -----------------------------------------------------
  async function openChapter(id) {
    let html;
    do {
      await flush();
      html = await window.api.readChapter(id);
    } while (dirtyText);   // the person typed while the file was loading

    current = index.chapters.find((c) => c.id === id);
    editor.load(html);
    chTitleEl.value = current.title;
    synopsisEl.value = current.synopsis;
    const before = current.words;
    recount();
    if (current.words !== before) dirtyIndex = true;
    renderList();
    updateCounts();
    try { localStorage.setItem(LAST_KEY, id); } catch { /* ignore */ }
    editor.focus();
  }

  async function addChapter() {
    await flush();
    const id = await window.api.createChapter();
    index.chapters.push({ id, title: `Chapter ${index.chapters.length + 1}`, words: 0, synopsis: '' });
    await window.api.writeIndex(index);
    await openChapter(id);
    chTitleEl.select();
  }

  async function deleteChapter() {
    if (!current) return;
    const ok = await emw.ask({
      message: `Delete “${label(current)}”? This can’t be undone.`,
      okLabel: 'Delete chapter',
      danger: true
    });
    if (!ok) return;
    clearTimeout(timer);
    dirtyText = false;
    const doomed = current;
    const i = index.chapters.indexOf(doomed);
    index.chapters.splice(i, 1);
    await window.api.deleteChapter(doomed.id);
    if (index.chapters.length === 0) {
      const id = await window.api.createChapter();
      index.chapters.push({ id, title: 'Chapter 1', words: 0, synopsis: '' });
    }
    current = null;
    dirtyIndex = false;
    await window.api.writeIndex(index);
    await openChapter(index.chapters[Math.min(i, index.chapters.length - 1)].id);
  }

  emw.actions.newChapter = addChapter;
  emw.actions.deleteChapter = deleteChapter;
  emw.actions.save = flush;

  // ---- events --------------------------------------------------------------
  editor.onChange(() => { dirtyText = true; scheduleSave(); });

  chTitleEl.addEventListener('input', () => {
    current.title = chTitleEl.value;
    const row = activeRow();
    if (row) row.querySelector('.name').textContent = label(current);
    dirtyIndex = true;
    scheduleSave();
  });

  synopsisEl.addEventListener('input', () => {
    current.synopsis = synopsisEl.value;
    dirtyIndex = true;
    scheduleSave();
  });

  novelTitleEl.addEventListener('input', () => {
    index.title = novelTitleEl.value;
    dirtyIndex = true;
    scheduleSave();
  });

  $('#add').addEventListener('click', addChapter);

  listEl.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li && li.dataset.id !== current.id) openChapter(li.dataset.id);
  });

  // Drag to reorder chapters.
  let dragId = null;
  const clearMarks = () => listEl.querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  const isBefore = (e, li) => {
    const r = li.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  };

  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    dragId = li.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  listEl.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    clearMarks();
    const li = e.target.closest('li');
    if (li && li.dataset.id !== dragId) li.classList.add(isBefore(e, li) ? 'drop-before' : 'drop-after');
  });
  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const li = e.target.closest('li');
    if (!dragId || !li || li.dataset.id === dragId) return;
    const before = isBefore(e, li);
    const [moved] = index.chapters.splice(index.chapters.findIndex((c) => c.id === dragId), 1);
    let to = index.chapters.findIndex((c) => c.id === li.dataset.id);
    if (!before) to += 1;
    index.chapters.splice(to, 0, moved);
    dirtyIndex = true;
    renderList();
    scheduleSave();
  });
  listEl.addEventListener('dragend', () => { dragId = null; clearMarks(); });

  // Keyboard shortcuts.
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); }
    else if (mod && !e.altKey && e.key.toLowerCase() === 'n' && emw.view() === 'manuscript') { e.preventDefault(); addChapter(); }
    else if (e.altKey && !mod) {
      const action = { Digit1: 'toggleHierarchy', Digit2: 'toggleRibbon', Digit3: 'toggleInspector' }[e.code];
      if (action) { e.preventDefault(); emw.actions[action](); }
    }
  });

  // Save when leaving.
  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.api.onBeforeClose(async () => { await flush(); window.api.closeReady(); });

  // ---- start ---------------------------------------------------------------
  (async function init() {
    index = await window.api.loadNovel();
    for (const c of index.chapters) { c.title ??= ''; c.words ??= 0; c.synopsis ??= ''; }
    novelTitleEl.value = index.title;
    let last = '';
    try { last = localStorage.getItem(LAST_KEY) || ''; } catch { /* ignore */ }
    const start = index.chapters.find((c) => c.id === last) || index.chapters[0];
    await openChapter(start.id);
  })();
})();
