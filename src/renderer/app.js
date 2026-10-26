'use strict';

const $ = (sel) => document.querySelector(sel);
const listEl = $('#chapters');
const novelTitleEl = $('#novel-title');
const titleEl = $('#title');
const editorEl = $('#editor');
const chapterWordsEl = $('#chapter-words');
const totalWordsEl = $('#total-words');
const saveStateEl = $('#save-state');

const SAVE_DELAY_MS = 600;

let index = null;      // { title, chapters: [{ id, title, words }] }
let current = null;    // the chapter object being edited
let timer = null;
let dirtyText = false;
let dirtyIndex = false;

const countWords = (text) => (text.match(/\S+/g) || []).length;
const plural = (n) => `${n.toLocaleString()} ${n === 1 ? 'word' : 'words'}`;

function setSaveState(text) { saveStateEl.textContent = text; }

function updateCounts() {
  chapterWordsEl.textContent = plural(current ? current.words : 0);
  const total = index.chapters.reduce((sum, c) => sum + c.words, 0);
  totalWordsEl.textContent = `${plural(total)} in novel`;
}

function renderList() {
  const frag = document.createDocumentFragment();
  for (const ch of index.chapters) {
    const li = document.createElement('li');
    li.dataset.id = ch.id;
    if (current && ch.id === current.id) li.setAttribute('aria-current', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = ch.title || 'Untitled';
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = ch.words.toLocaleString();
    li.append(name, count);
    frag.append(li);
  }
  listEl.replaceChildren(frag);
}

// Write anything pending to disk right now.
async function flush() {
  clearTimeout(timer);
  if (!current) return;
  const jobs = [];
  if (dirtyText) { dirtyText = false; jobs.push(window.api.writeChapter(current.id, editorEl.value)); }
  if (dirtyIndex) { dirtyIndex = false; jobs.push(window.api.writeIndex(index)); }
  if (jobs.length) {
    await Promise.all(jobs);
    setSaveState('Saved');
  }
}

// Debounced autosave: typing stays instant, disk work happens after a pause.
function scheduleSave() {
  if (!dirtyText && !dirtyIndex) setSaveState('Saving…');
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (dirtyText) {
      current.words = countWords(editorEl.value);
      dirtyIndex = true;
      updateCounts();
      renderList();
    }
    flush();
  }, SAVE_DELAY_MS);
}

async function openChapter(id) {
  await flush();
  current = index.chapters.find((c) => c.id === id);
  editorEl.value = await window.api.readChapter(id);
  titleEl.value = current.title;
  editorEl.scrollTop = 0;
  renderList();
  updateCounts();
  editorEl.focus();
}

async function addChapter() {
  await flush();
  const id = await window.api.createChapter();
  index.chapters.push({ id, title: `Chapter ${index.chapters.length + 1}`, words: 0 });
  dirtyIndex = true;
  current = index.chapters[index.chapters.length - 1];
  await flush();
  await openChapter(id);
}

async function removeChapter() {
  if (!current || !confirm(`Delete "${current.title}"? This can't be undone.`)) return;
  const doomed = current;
  const i = index.chapters.indexOf(doomed);
  clearTimeout(timer);
  dirtyText = false;
  index.chapters.splice(i, 1);
  await window.api.deleteChapter(doomed.id);
  if (index.chapters.length === 0) {
    const id = await window.api.createChapter();
    index.chapters.push({ id, title: 'Chapter 1', words: 0 });
  }
  current = null;
  await window.api.writeIndex(index);
  await openChapter(index.chapters[Math.min(i, index.chapters.length - 1)].id);
}

// Events
editorEl.addEventListener('input', () => { dirtyText = true; scheduleSave(); });

titleEl.addEventListener('input', () => {
  current.title = titleEl.value;
  dirtyIndex = true;
  renderList();
  scheduleSave();
});

novelTitleEl.addEventListener('input', () => {
  index.title = novelTitleEl.value;
  dirtyIndex = true;
  scheduleSave();
});

listEl.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li && li.dataset.id !== current.id) openChapter(li.dataset.id);
});

$('#add').addEventListener('click', addChapter);
$('#remove').addEventListener('click', removeChapter);

// Save when the window loses focus or is closing.
window.addEventListener('blur', flush);
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); }
});

(async function init() {
  index = await window.api.loadNovel();
  novelTitleEl.value = index.title;
  await openChapter(index.chapters[0].id);
})();
