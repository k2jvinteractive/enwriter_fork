// The single source of truth for the novel's structure: plotlines, chapters
// and scenes. The Manuscript panel and the Timeline both read and write here,
// which is what keeps them in sync. Every change is undoable.
(() => {
  'use strict';
  const emw = window.emw;
  const MAX_UNDO = 100;
  const COALESCE_MS = 1200;
  const STATUSES = { idea: 'Idea', draft: 'Draft', revised: 'Revised', done: 'Done' };

  let data = null;
  let undoStack = [];
  let redoStack = [];
  let lastKey = null;
  let lastTime = 0;
  const listeners = [];

  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  const emit = (info) => listeners.forEach((cb) => cb(info));
  const clamp = (n, max) => Math.max(0, Math.min(n, max));

  // ---- colours: a random hue, kept away from the hues already in use -------
  function hexToHue(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 0;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const x = (v) => Math.round(255 * v).toString(16).padStart(2, '0');
    return '#' + x(f(0)) + x(f(8)) + x(f(4));
  }
  function randomColor() {
    const used = data.plotlines.map((p) => hexToHue(p.color));
    let best = 0, bestDist = -1;
    for (let i = 0; i < 30; i++) {
      const h = Math.random() * 360;
      const dist = Math.min(360, ...used.map((u) => { const d = Math.abs(h - u); return Math.min(d, 360 - d); }));
      if (dist > bestDist) { bestDist = dist; best = h; }
    }
    return hslToHex(best, 72, 62);
  }

  // ---- shapes --------------------------------------------------------------
  const blankChapter = (title = '') => ({ id: uid(), title, words: 0, synopsis: '', scenes: [] });
  const blankScene = (plotline, title = '') => ({
    id: uid(), title, plotline, words: 0, description: '', notes: '',
    characters: [], places: [], tags: [], color: '', status: 'idea'
  });

  function normalize() {
    data.title ??= 'Untitled Novel';
    if (!Array.isArray(data.plotlines)) data.plotlines = [];
    if (!data.plotlines.length) data.plotlines.push({ id: uid(), name: 'Main Plot', color: '#e8caa4' });
    if (!Array.isArray(data.chapters)) data.chapters = [];
    if (!data.chapters.length) data.chapters.push(blankChapter());
    const first = data.plotlines[0].id;
    const known = new Set(data.plotlines.map((p) => p.id));
    for (const ch of data.chapters) {
      ch.title = /^Chapter \d+$/.test(ch.title || '') ? '' : (ch.title || ''); // empty = auto-numbered
      ch.words ??= 0;
      ch.synopsis ??= '';
      ch.scenes = (ch.scenes || []).map((s) =>
        Object.assign(blankScene(first), s, known.has(s.plotline) ? {} : { plotline: first }));
    }
  }

  function load(raw) {
    data = raw;
    normalize();
    undoStack = []; redoStack = []; lastKey = null;
    return data;
  }

  // ---- lookups ---------------------------------------------------------------
  const findChapter = (id) => data.chapters.find((c) => c.id === id);
  const findPlotline = (id) => data.plotlines.find((p) => p.id === id);
  function findScene(id) {
    for (const chapter of data.chapters) {
      const scene = chapter.scenes.find((s) => s.id === id);
      if (scene) return { scene, chapter };
    }
    return null;
  }
  function doc(id) {
    const c = findChapter(id);
    if (c) return { kind: 'chapter', item: c, chapter: c };
    const f = findScene(id);
    return f ? { kind: 'scene', item: f.scene, chapter: f.chapter } : null;
  }
  const chapterWords = (ch) => ch.words + ch.scenes.reduce((n, s) => n + s.words, 0);
  const totalWords = () => data.chapters.reduce((n, c) => n + chapterWords(c), 0);

  // ---- undo machinery --------------------------------------------------------
  function record(before, label, opts) {
    const now = Date.now();
    if (opts.coalesce && opts.coalesce === lastKey && now - lastTime < COALESCE_MS && undoStack.length) {
      lastTime = now; redoStack.length = 0; return;   // keep the earlier snapshot: one undo step for a burst of typing
    }
    undoStack.push({ json: before, label });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    lastKey = opts.coalesce || null;
    lastTime = now;
  }

  function commit(label, fn, opts = {}) {
    const before = JSON.stringify(data);
    const result = fn();
    if (JSON.stringify(data) === before) return result;   // nothing changed: no undo step
    record(before, label, opts);
    emit({ label });
    return result;
  }

  // Word counts come from the text files, so undo must not roll them back.
  function restore(json) {
    const words = new Map();
    for (const c of data.chapters) { words.set(c.id, c.words); for (const s of c.scenes) words.set(s.id, s.words); }
    data = JSON.parse(json);
    for (const c of data.chapters) {
      if (words.has(c.id)) c.words = words.get(c.id);
      for (const s of c.scenes) if (words.has(s.id)) s.words = words.get(s.id);
    }
  }
  function step(from, to, verb) {
    const entry = from.pop();
    if (!entry) return null;
    to.push({ json: JSON.stringify(data), label: entry.label });
    restore(entry.json);
    lastKey = null;
    emit({ label: verb + ' ' + entry.label });
    return entry.label;
  }
  const undo = () => step(undoStack, redoStack, 'Undo');
  const redo = () => step(redoStack, undoStack, 'Redo');

  // ---- chapters --------------------------------------------------------------
  const addChapter = (at = data.chapters.length, title = '') => commit('add chapter', () => {
    const ch = blankChapter(title);
    data.chapters.splice(clamp(at, data.chapters.length), 0, ch);
    return ch.id;
  });

  const insertChapterWithScene = (at, plotlineId) => commit('add chapter and scene', () => {
    const ch = blankChapter();
    const scene = blankScene(plotlineId);
    ch.scenes.push(scene);
    data.chapters.splice(clamp(at, data.chapters.length), 0, ch);
    return { chapterId: ch.id, sceneId: scene.id };
  });

  const updateChapter = (id, patch, opts) => commit('edit chapter', () => {
    const c = findChapter(id);
    if (c) Object.assign(c, patch);
  }, opts);

  const deleteChapter = (id) => {
    if (data.chapters.length <= 1) return false;
    return commit('delete chapter', () => {
      data.chapters.splice(data.chapters.findIndex((c) => c.id === id), 1);
      return true;
    });
  };

  const moveChapter = (id, at) => commit('move chapter', () => {
    const from = data.chapters.findIndex((c) => c.id === id);
    if (from < 0) return;
    const [ch] = data.chapters.splice(from, 1);
    let pos = at;
    if (from < pos) pos--;
    data.chapters.splice(clamp(pos, data.chapters.length), 0, ch);
  });

  // ---- scenes ----------------------------------------------------------------
  const addScene = (chapterId, plotlineId, opts = {}) => commit('add scene', () => {
    const ch = findChapter(chapterId);
    if (!ch) return null;
    const scene = blankScene(plotlineId, opts.title || '');
    const at = opts.at === undefined || opts.at === '' ? ch.scenes.length : clamp(Number(opts.at), ch.scenes.length);
    ch.scenes.splice(at, 0, scene);
    return scene.id;
  });

  const updateScene = (id, patch, opts) => commit('edit scene', () => {
    const f = findScene(id);
    if (f) Object.assign(f.scene, patch);
  }, opts);

  const deleteScene = (id) => commit('delete scene', () => {
    const f = findScene(id);
    if (!f) return false;
    f.chapter.scenes.splice(f.chapter.scenes.indexOf(f.scene), 1);
    return true;
  });

  const moveScene = (id, toChapterId, at, plotlineId) => commit('move scene', () => {
    const f = findScene(id);
    const to = findChapter(toChapterId);
    if (!f || !to) return;
    const fromIndex = f.chapter.scenes.indexOf(f.scene);
    f.chapter.scenes.splice(fromIndex, 1);
    let pos = at === undefined ? to.scenes.length : at;
    if (f.chapter === to && fromIndex < pos) pos--;
    to.scenes.splice(clamp(pos, to.scenes.length), 0, f.scene);
    if (plotlineId) f.scene.plotline = plotlineId;
  });

  const duplicateScene = (id) => commit('duplicate scene', () => {
    const f = findScene(id);
    if (!f) return null;
    const copy = JSON.parse(JSON.stringify(f.scene));
    copy.id = uid();
    if (copy.title) copy.title += ' (copy)';
    f.chapter.scenes.splice(f.chapter.scenes.indexOf(f.scene) + 1, 0, copy);
    return copy.id;
  });

  // ---- plotlines -------------------------------------------------------------
  const addPlotline = (name) => commit('add plotline', () => {
    const p = { id: uid(), name: name || `Plotline ${data.plotlines.length + 1}`, color: randomColor() };
    data.plotlines.push(p);
    return p.id;
  });

  const updatePlotline = (id, patch, opts) => commit('edit plotline', () => {
    const p = findPlotline(id);
    if (p) Object.assign(p, patch);
  }, opts);

  const deletePlotline = (id) => {
    if (data.plotlines.length <= 1) return false;
    return commit('delete plotline', () => {
      data.plotlines.splice(data.plotlines.findIndex((p) => p.id === id), 1);
      for (const ch of data.chapters) ch.scenes = ch.scenes.filter((s) => s.plotline !== id);
      return true;
    });
  };

  const movePlotline = (id, at) => commit('move plotline', () => {
    const from = data.plotlines.findIndex((p) => p.id === id);
    if (from < 0) return;
    const [p] = data.plotlines.splice(from, 1);
    let pos = at;
    if (from < pos) pos--;
    data.plotlines.splice(clamp(pos, data.plotlines.length), 0, p);
  });

  // Word counts are measured, not edited, so they are not undo steps.
  function setWords(id, n) {
    const d = doc(id);
    if (!d || d.item.words === n) return false;
    d.item.words = n;
    return true;
  }

  emw.store = {
    get data() { return data; },
    load, on: (cb) => listeners.push(cb),
    find: { chapter: findChapter, scene: findScene, plotline: findPlotline },
    doc, STATUSES, chapterWords, totalWords, setWords,
    addChapter, insertChapterWithScene, updateChapter, deleteChapter, moveChapter,
    addScene, updateScene, deleteScene, moveScene, duplicateScene,
    addPlotline, updatePlotline, deletePlotline, movePlotline,
    undo, redo, canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0
  };
})();
