// Chapter overview: a chapter is a folder of scenes, so clicking one shows a grid of scene cards
// instead of an editor. Renders from the store; holds no copy of the data.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const host = document.getElementById('chapter-view');

  let drag = null;   // { id } of the card being dragged from this view

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const chapter = () => { const id = emw.curChapterId?.(); return id ? S.find.chapter(id) : null; };
  const chapterLabel = (ch) => ch.title.trim() || `Chapter ${S.data.chapters.indexOf(ch) + 1}`;

  function card(s, ch) {
    const pl = S.find.plotline(s.plotline);
    const c = el('div', 'cv-card');
    c.dataset.id = s.id;
    c.tabIndex = 0;
    c.draggable = true;
    c.setAttribute('role', 'button');
    c.style.setProperty('--c', s.color || (pl ? pl.color : 'var(--accent)'));
    const title = s.title.trim();
    const meta = el('div', 'cv-meta-row');
    const dot = el('i', `status s-${s.status}`);
    dot.title = S.STATUSES[s.status] || '';
    meta.append(dot);
    if (s.words) meta.append(document.createTextNode(s.words.toLocaleString()));
    const tags = el('div', 'cv-tags');
    for (const id of s.tags.slice(0, 6)) {
      const t = S.entity('tags', id);
      if (!t) continue;
      const d = el('i', 'tag-dot');
      d.style.setProperty('--tc', t.color);
      d.title = t.name;
      tags.append(d);
    }
    c.setAttribute('aria-label', title || 'Untitled scene');
    c.append(el('div', 'cv-card-title' + (title ? '' : ' untitled'), title || 'Untitled scene'));
    if (s.description.trim()) c.append(el('div', 'cv-card-desc', s.description.trim()));
    c.append(tags, meta);
    return c;
  }

  function render() {
    const ch = chapter();
    host.hidden = !ch;
    if (!ch) { host.replaceChildren(); return; }
    const focused = document.activeElement?.closest?.('.cv-card')?.dataset.id;

    const head = el('header', 'cv-head');
    const title = el('h1', 'cv-title' + (ch.title.trim() ? '' : ' untitled'), chapterLabel(ch));
    title.title = 'Double-click to rename';
    title.dataset.act = 'rename';
    head.append(title, el('p', 'cv-sub', `${count(ch.scenes.length, 'scene')} · ${count(S.chapterWords(ch), 'word')}`));

    const grid = el('div', 'cv-grid');
    grid.setAttribute('role', 'list');
    for (const s of ch.scenes) grid.append(card(s, ch));
    const add = el('button', 'cv-add', '+');
    add.type = 'button';
    add.title = 'Add a scene';
    add.setAttribute('aria-label', 'Add a scene');
    grid.append(add);

    const body = el('div', 'cv-body');
    body.append(grid);
    if (!ch.scenes.length) body.append(el('p', 'cv-hint hint', 'This chapter has no scenes yet. Add one to start writing.'));
    host.replaceChildren(head, body);
    if (focused) host.querySelector(`.cv-card[data-id="${focused}"]`)?.focus();
  }

  const addScene = (ch) => {
    const last = ch.scenes[ch.scenes.length - 1];
    const id = S.addScene(ch.id, last ? last.plotline : S.data.plotlines[0].id);
    if (id) emw.actions.openScene(id);
  };

  function rename() {
    const ch = chapter();
    const t = host.querySelector('.cv-title');
    if (!ch || !t) return;
    emw.rename(t, {
      value: ch.title,
      placeholder: `Chapter ${S.data.chapters.indexOf(ch) + 1}`,
      onCommit: (v) => S.updateChapter(ch.id, { title: v }),
      onDone: render
    });
  }

  // ---- events ---------------------------------------------------------------------
  host.addEventListener('click', (e) => {
    const ch = chapter();
    if (!ch || e.target.closest('.rename')) return;
    if (e.target.closest('.cv-add')) { addScene(ch); return; }
    const c = e.target.closest('.cv-card');
    if (c) emw.actions.openScene(c.dataset.id);
  });

  host.addEventListener('dblclick', (e) => { if (e.target.closest('.cv-title')) rename(); });

  host.addEventListener('keydown', (e) => {
    const c = e.target.closest?.('.cv-card');
    if (c && e.target === c) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emw.actions.openScene(c.dataset.id); }
      else if (e.key === 'Delete') { e.preventDefault(); emw.actions.deleteScene(c.dataset.id); }
    } else if (e.target.classList?.contains('cv-title') && e.key === 'F2') rename();
  });

  host.addEventListener('contextmenu', (e) => {
    const c = e.target.closest('.cv-card');
    if (!c) return;
    e.preventDefault();
    const id = c.dataset.id;
    emw.menu(e.clientX, e.clientY, [
      { label: 'Open', run: () => emw.actions.openScene(id) },
      { label: 'Duplicate', run: () => emw.actions.duplicateScene(id) },
      null,
      { label: 'Send to Darlings', run: () => emw.darlings.send('scene', id, { origin: 'manuscript' }) },
      { label: 'Delete scene', danger: true, run: () => emw.actions.deleteScene(id) }
    ]);
  });

  // Drag to reorder within the chapter. The store does the move, so undo and the other views agree.
  const clearMarks = () => host.querySelectorAll('.drop-before, .drop-after')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after'));

  function dropTarget(e) {
    const ch = chapter();
    const t = e.target.closest?.('.cv-card, .cv-add');
    if (!drag || !ch || !t || t.dataset.id === drag.id) return null;
    if (t.classList.contains('cv-add')) return { t, cls: 'drop-before', at: ch.scenes.length };
    const r = t.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    const idx = ch.scenes.findIndex((s) => s.id === t.dataset.id);
    return { t, cls: before ? 'drop-before' : 'drop-after', at: idx + (before ? 0 : 1) };
  }

  host.addEventListener('dragstart', (e) => {
    const c = e.target.closest?.('.cv-card');
    if (!c || c !== e.target) return;
    drag = { id: c.dataset.id };
    emw.dragItem = { kind: 'scene', id: drag.id, origin: 'manuscript' };   // so the Darlings tab can take it
    c.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
  });
  host.addEventListener('dragover', (e) => {
    clearMarks();
    const t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    t.t.classList.add(t.cls);
  });
  host.addEventListener('drop', (e) => {
    const t = dropTarget(e);
    const ch = chapter();
    clearMarks();
    if (!t || !ch) return;
    e.preventDefault();
    S.moveScene(drag.id, ch.id, t.at);
  });
  host.addEventListener('dragend', () => {
    drag = null;
    emw.dragItem = null;
    clearMarks();
    host.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  });

  // ---- when to draw -----------------------------------------------------------------
  S.on((info) => { if (!(info && info.quiet)) render(); });
  document.addEventListener('emw:doc', render);
  render();   // in case the app opened a chapter before this script ran
})();
