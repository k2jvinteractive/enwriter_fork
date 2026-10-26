// The Timeline: plotlines down the side, chapters across the top,
// scenes in the cells. Reads and writes the shared store.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const $ = (s) => document.querySelector(s);

  const grid = $('#tl-grid');
  const searchEl = $('#tl-search');
  const sizeBtn = $('#tl-size');
  const undoBtn = $('#tl-undo');
  const redoBtn = $('#tl-redo');
  const summaryEl = $('#tl-summary');
  const COMPACT_KEY = 'emwriter.tl.compact';

  let compact = false;
  let query = '';
  let rafId = 0;
  let stale = true;
  try { compact = localStorage.getItem(COMPACT_KEY) === '1'; } catch { /* ignore */ }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const chapterLabel = (ch, i) => ch.title.trim() || `Chapter ${i + 1}`;
  const sceneLabel = (s) => s.title.trim() || 'Untitled scene';
  const haystack = (s) => [s.title, s.description, s.notes, ...s.characters, ...s.places, ...s.tags].join('\n').toLowerCase();

  // ---- building the grid -----------------------------------------------------
  function kebab() {
    const b = el('button', 'kebab', '⋯');
    b.type = 'button';
    b.title = 'More actions';
    b.setAttribute('aria-label', 'More actions');
    return b;
  }
  function gap(at, plotlineId, title) {
    const b = el('button', 'gap-add');
    b.type = 'button';
    b.dataset.at = at;
    if (plotlineId) b.dataset.plotline = plotlineId;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(el('span', '', '+'));
    return b;
  }

  function card(s, ch, pl, q) {
    const c = el('div', 'card');
    c.dataset.id = s.id;
    c.tabIndex = 0;
    c.draggable = true;
    c.setAttribute('role', 'button');
    c.style.setProperty('--c', s.color || pl.color);
    if (q && !haystack(s).includes(q)) c.classList.add('dim');
    const ins = el('span', 'ins');
    ins.dataset.at = ch.scenes.indexOf(s);
    ins.title = 'Insert a scene above';
    ins.append(el('b', '', '+'));
    const text = el('div', 'card-text' + (s.title.trim() ? '' : ' untitled'), sceneLabel(s));
    const meta = el('div', 'card-meta');
    const dot = el('i', `status s-${s.status}`);
    dot.title = S.STATUSES[s.status] || '';
    meta.append(dot);
    if (s.words) meta.append(document.createTextNode(s.words.toLocaleString()));
    c.append(ins, text, meta);
    return c;
  }

  function slot(scenes, ch) {
    const b = el('button', 'slot ' + (scenes.length ? 'thin' : 'full'), '+');
    b.type = 'button';
    b.title = 'Add a scene';
    b.setAttribute('aria-label', 'Add a scene');
    b.dataset.at = scenes.length ? ch.scenes.indexOf(scenes[scenes.length - 1]) + 1 : '';
    return b;
  }

  function render() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    stale = false;
    const d = S.data;
    const q = query.trim().toLowerCase();
    grid.classList.toggle('compact', compact);
    sizeBtn.setAttribute('aria-pressed', String(compact));
    const frag = document.createDocumentFragment();

    const head = el('div', 'tl-row tl-head');
    head.append(el('div', 'tl-corner'));
    d.chapters.forEach((ch, i) => {
      const h = el('div', 'tl-col-head');
      h.dataset.id = ch.id;
      h.draggable = true;
      if (ch.title.trim()) h.append(el('div', 'num', `Chapter ${i + 1}`));
      h.append(el('div', 'name', chapterLabel(ch, i)), el('div', 'count', plural(S.chapterWords(ch), 'word')), kebab(), gap(i, null, 'Insert a chapter here'));
      head.append(h);
    });
    const endHead = el('div', 'tl-end');
    const addCh = el('button', 'tl-add-ch', '+');
    addCh.type = 'button';
    addCh.dataset.act = 'add-chapter';
    addCh.title = 'Add chapter';
    addCh.setAttribute('aria-label', 'Add chapter');
    endHead.append(addCh);
    head.append(endHead);
    frag.append(head);

    for (const pl of d.plotlines) {
      const row = el('div', 'tl-row tl-plot');
      row.dataset.id = pl.id;
      row.style.setProperty('--pl', pl.color);
      const label = el('div', 'tl-label');
      label.dataset.id = pl.id;
      label.draggable = true;
      const swatch = el('label', 'swatch');
      swatch.title = 'Change colour';
      const ci = el('input');
      ci.type = 'color';
      ci.value = pl.color;
      ci.setAttribute('aria-label', `Colour of ${pl.name}`);
      swatch.append(ci);
      label.append(swatch, el('span', 'name', pl.name), kebab());
      row.append(label);

      d.chapters.forEach((ch, i) => {
        const cell = el('div', 'tl-cell');
        cell.dataset.chapter = ch.id;
        cell.dataset.plotline = pl.id;
        const scenes = ch.scenes.filter((s) => s.plotline === pl.id);
        scenes.forEach((s) => cell.append(card(s, ch, pl, q)));
        cell.append(slot(scenes, ch), gap(i, pl.id, 'Insert a chapter with a scene here'));
        row.append(cell);
      });
      const endCell = el('div', 'tl-end');
      endCell.append(gap(d.chapters.length, pl.id, 'Add a chapter with a scene here'));
      row.append(endCell);
      frag.append(row);
    }

    const addRow = el('div', 'tl-row tl-addrow');
    const addPlot = el('button', 'tl-add-plot', '+');
    addPlot.type = 'button';
    addPlot.dataset.act = 'add-plot';
    addPlot.title = 'New plotline';
    addPlot.setAttribute('aria-label', 'New plotline');
    addRow.append(addPlot);
    frag.append(addRow);

    grid.replaceChildren(frag);
    updateToolbar();
  }

  function schedule() { if (!rafId) rafId = requestAnimationFrame(render); }

  function updateToolbar() {
    undoBtn.disabled = !S.canUndo();
    redoBtn.disabled = !S.canRedo();
    const scenes = S.data.chapters.reduce((n, c) => n + c.scenes.length, 0);
    summaryEl.textContent = `${plural(S.data.chapters.length, 'chapter')}, ${plural(scenes, 'scene')}, ${plural(S.data.plotlines.length, 'plotline')}`;
  }

  // ---- actions -----------------------------------------------------------------
  const firstPlot = () => S.data.plotlines[0].id;
  const undoToast = (text) => emw.toast(text, { action: { label: 'Undo', run: () => { S.undo(); } } });

  function insertChapter(at, plotlineId) {
    if (plotlineId) {
      const r = S.insertChapterWithScene(at, plotlineId);
      render();
      emw.openScene(r.sceneId, { focusTitle: true });
    } else {
      const id = S.addChapter(at);
      render();
      renameChapter(id);
    }
  }
  function addScene(chapterId, plotlineId, at) {
    const id = S.addScene(chapterId, plotlineId, { at });
    render();
    emw.openScene(id, { focusTitle: true });
  }
  function renameChapter(id) {
    const h = grid.querySelector(`.tl-col-head[data-id="${id}"]`);
    const ch = S.find.chapter(id);
    if (!h || !ch) return;
    h.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    emw.rename(h.querySelector('.name'), {
      value: ch.title,
      placeholder: `Chapter ${S.data.chapters.indexOf(ch) + 1}`,
      onCommit: (v) => S.updateChapter(id, { title: v }),
      onDone: render
    });
  }
  function renamePlot(id) {
    const l = grid.querySelector(`.tl-label[data-id="${id}"]`);
    const pl = S.find.plotline(id);
    if (!l || !pl) return;
    emw.rename(l.querySelector('.name'), {
      value: pl.name,
      placeholder: 'Plotline name',
      onCommit: (v) => { if (v) S.updatePlotline(id, { name: v }); },
      onDone: render
    });
  }
  function deleteChapter(id) {
    const ch = S.find.chapter(id);
    const label = chapterLabel(ch, S.data.chapters.indexOf(ch));
    if (S.deleteChapter(id) === false) { emw.toast('A novel needs at least one chapter'); return; }
    render();
    undoToast(`Deleted “${label}”`);
  }
  function deletePlot(id) {
    const pl = S.find.plotline(id);
    const n = S.data.chapters.reduce((sum, c) => sum + c.scenes.filter((s) => s.plotline === id).length, 0);
    if (S.deletePlotline(id) === false) { emw.toast('Keep at least one plotline'); return; }
    render();
    undoToast(`Deleted “${pl.name}”${n ? ` and its ${plural(n, 'scene')}` : ''}`);
  }
  function addPlot() {
    const id = S.addPlotline();
    render();
    renamePlot(id);
    grid.querySelector(`.tl-label[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function openMenuFor(node, x, y) {
    const id = node.dataset.id;
    if (node.classList.contains('tl-col-head')) {
      const i = S.data.chapters.findIndex((c) => c.id === id);
      emw.menu(x, y, [
        { label: 'Rename', run: () => renameChapter(id) },
        { label: 'Add scene', run: () => addScene(id, firstPlot()) },
        null,
        { label: 'Insert chapter before', run: () => insertChapter(i, null) },
        { label: 'Insert chapter after', run: () => insertChapter(i + 1, null) },
        null,
        { label: 'Delete chapter', danger: true, run: () => deleteChapter(id) }
      ]);
    } else if (node.classList.contains('tl-label')) {
      const i = S.data.plotlines.findIndex((p) => p.id === id);
      emw.menu(x, y, [
        { label: 'Rename', run: () => renamePlot(id) },
        { label: 'Change colour', run: () => node.querySelector('input[type=color]').click() },
        null,
        { label: 'Move up', disabled: i === 0, run: () => { S.movePlotline(id, i - 1); render(); } },
        { label: 'Move down', disabled: i === S.data.plotlines.length - 1, run: () => { S.movePlotline(id, i + 2); render(); } },
        null,
        { label: 'Delete plotline', danger: true, run: () => deletePlot(id) }
      ]);
    } else if (node.classList.contains('card')) {
      emw.menu(x, y, [
        { label: 'Open details', run: () => emw.openScene(id) },
        { label: 'Open in manuscript', run: () => emw.actions.openScene(id) },
        { label: 'Duplicate', run: () => emw.actions.duplicateScene(id) },
        null,
        { label: 'Delete scene', danger: true, run: () => emw.actions.deleteScene(id) }
      ]);
    }
  }

  // ---- events ------------------------------------------------------------------
  grid.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('.rename') || t.closest('.swatch')) return;
    const g = t.closest('.gap-add');
    if (g) { insertChapter(Number(g.dataset.at), g.dataset.plotline || null); return; }
    if (t.closest('[data-act="add-chapter"]')) { insertChapter(S.data.chapters.length, null); return; }
    if (t.closest('[data-act="add-plot"]')) { addPlot(); return; }
    const k = t.closest('.kebab');
    if (k) { const r = k.getBoundingClientRect(); openMenuFor(k.closest('.tl-col-head, .tl-label'), r.left, r.bottom); return; }
    const sl = t.closest('.slot');
    if (sl) { const cell = sl.closest('.tl-cell'); addScene(cell.dataset.chapter, cell.dataset.plotline, sl.dataset.at); return; }
    const ins = t.closest('.ins');
    if (ins) { const cell = ins.closest('.tl-cell'); addScene(cell.dataset.chapter, cell.dataset.plotline, ins.dataset.at); return; }
    const c = t.closest('.card');
    if (c) emw.openScene(c.dataset.id);
  });

  grid.addEventListener('dblclick', (e) => {
    const n = e.target.closest('.name');
    if (!n) return;
    const h = n.closest('.tl-col-head');
    const l = n.closest('.tl-label');
    if (h) renameChapter(h.dataset.id); else if (l) renamePlot(l.dataset.id);
  });

  grid.addEventListener('contextmenu', (e) => {
    const n = e.target.closest('.card, .tl-col-head, .tl-label');
    if (!n || e.target.closest('.rename')) return;
    e.preventDefault();
    openMenuFor(n, e.clientX, e.clientY);
  });

  grid.addEventListener('keydown', (e) => {
    const c = e.target.closest?.('.card');
    if (!c || e.target !== c) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emw.openScene(c.dataset.id); }
    else if (e.key === 'Delete') { e.preventDefault(); emw.actions.deleteScene(c.dataset.id); }
  });

  // Plotline colour: preview live, commit when the picker closes.
  grid.addEventListener('input', (e) => {
    if (e.target.type !== 'color') return;
    e.target.closest('.tl-row').style.setProperty('--pl', e.target.value);
  });
  grid.addEventListener('change', (e) => {
    if (e.target.type !== 'color') return;
    S.updatePlotline(e.target.closest('.tl-row').dataset.id, { color: e.target.value });
  });

  // ---- drag and drop ------------------------------------------------------------
  let drag = null;
  const clearMarks = () => grid.querySelectorAll('.drop-before, .drop-after, .drop-over')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-over'));

  function dropTarget(e) {
    if (drag.kind === 'scene') {
      const cell = e.target.closest('.tl-cell');
      if (!cell) return null;
      const ch = S.find.chapter(cell.dataset.chapter);
      const cards = [...cell.querySelectorAll('.card')].filter((c) => c.dataset.id !== drag.id);
      const next = cards.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      let at, mark, cls;
      if (next) { at = ch.scenes.findIndex((s) => s.id === next.dataset.id); mark = next; cls = 'drop-before'; }
      else if (cards.length) { const last = cards[cards.length - 1]; at = ch.scenes.findIndex((s) => s.id === last.dataset.id) + 1; mark = last; cls = 'drop-after'; }
      else if (cell.querySelector(`.card[data-id="${drag.id}"]`)) return null;   // already alone in this cell
      else { at = undefined; mark = cell; cls = 'drop-over'; }
      return { mark, cls, run: () => S.moveScene(drag.id, ch.id, at, cell.dataset.plotline) };
    }
    const sel = drag.kind === 'chapter' ? '.tl-col-head' : '.tl-label';
    const n = e.target.closest(sel);
    if (!n || n.dataset.id === drag.id) return null;
    const r = n.getBoundingClientRect();
    const before = drag.kind === 'chapter' ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    const list = drag.kind === 'chapter' ? S.data.chapters : S.data.plotlines;
    const at = list.findIndex((x) => x.id === n.dataset.id) + (before ? 0 : 1);
    return {
      mark: n, cls: before ? 'drop-before' : 'drop-after',
      run: () => (drag.kind === 'chapter' ? S.moveChapter(drag.id, at) : S.movePlotline(drag.id, at))
    };
  }

  grid.addEventListener('dragstart', (e) => {
    const n = e.target.closest?.('.card, .tl-col-head, .tl-label');
    if (!n || n !== e.target) return;
    drag = { kind: n.classList.contains('card') ? 'scene' : n.classList.contains('tl-col-head') ? 'chapter' : 'plotline', id: n.dataset.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
    n.classList.add('dragging');
  });
  grid.addEventListener('dragover', (e) => {
    if (!drag) return;
    clearMarks();
    const t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    t.mark.classList.add(t.cls);
  });
  grid.addEventListener('drop', (e) => {
    if (!drag) return;
    const t = dropTarget(e);
    clearMarks();
    if (!t) return;
    e.preventDefault();
    t.run();
    render();
  });
  grid.addEventListener('dragend', () => {
    drag = null;
    clearMarks();
    grid.querySelector('.dragging')?.classList.remove('dragging');
  });

  // ---- toolbar -----------------------------------------------------------------
  undoBtn.addEventListener('click', () => emw.actions.undoStructure());
  redoBtn.addEventListener('click', () => emw.actions.redoStructure());
  sizeBtn.addEventListener('click', () => {
    compact = !compact;
    try { localStorage.setItem(COMPACT_KEY, compact ? '1' : '0'); } catch { /* ignore */ }
    render();
  });
  searchEl.addEventListener('input', () => { query = searchEl.value; schedule(); });

  // ---- keeping in step with the store -------------------------------------------
  S.on(() => {
    if (emw.view() === 'timeline') schedule(); else stale = true;
  });
  emw.onView((name) => { if (name === 'timeline' && S.data) render(); });
  emw.timelineRefresh = () => { if (emw.view() === 'timeline') render(); else stale = true; };
})();
