// The single source of truth for the novel's structure and reference material:
// plotlines, chapters, scenes, characters, places, notes and tags.
// Every view reads and writes here, which keeps them in sync. Every change is undoable.
(() => {
  'use strict';
  const emw = window.emw;
  const MAX_UNDO = 100;
  const COALESCE_MS = 1200;
  const STATUSES = { idea: 'Idea', draft: 'Draft', revised: 'Revised', done: 'Done' };
  const KINDS = ['characters', 'places', 'notes', 'tags'];
  const KIND_ONE = { characters: 'character', places: 'place', notes: 'note', tags: 'tag' };
  const SCENE_FIELD = { characters: 'characters', places: 'places', notes: 'noteIds', tags: 'tags' };
  const DEFAULT_CATEGORIES = {
    characters: ['Main', 'Supporting', 'Other'], places: ['Main', 'Other'], notes: ['General'], tags: ['General']
  };

  let data = null;
  let undoStack = [];
  let redoStack = [];
  let lastKey = null;
  let lastTime = 0;
  let depth = 0;
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
  function randomColor(usedHexes = []) {
    const used = usedHexes.filter((h) => /^#[0-9a-f]{6}$/i.test(h)).map(hexToHue);
    let best = 0, bestDist = -1;
    for (let i = 0; i < 30; i++) {
      const h = Math.random() * 360;
      const dist = Math.min(360, ...used.map((u) => { const d = Math.abs(h - u); return Math.min(d, 360 - d); }));
      if (dist > bestDist) { bestDist = dist; best = h; }
    }
    return hslToHex(best, 72, 62);
  }

  // ---- shapes --------------------------------------------------------------
  const dropcapDefaults = () => ({ on: false, font: '', lines: 3, gap: 8, color: '' });
  // A chapter is a named container of scenes. It has no text of its own.
  const blankChapter = (title = '') => ({ id: uid(), title, synopsis: '', scenes: [], dropcap: dropcapDefaults() });
  const blankScene = (plotline, title = '') => ({
    id: uid(), title, plotline, words: 0, description: '',
    characters: [], places: [], tags: [], noteIds: [], color: '', status: 'idea'
  });
  const entityDefaults = {
    characters: () => ({ name: '', aliases: [], short: '', tags: [], attributes: [], hasThumb: false, category: '' }),
    places: () => ({ name: '', aliases: [], short: '', tags: [], attributes: [], hasThumb: false, category: '' }),
    notes: () => ({ name: '', preview: '', tags: [], category: '' }),
    tags: () => ({ name: '', short: '', color: randomColor((data.tags || []).map((t) => t.color)), category: '' })
  };

  function normalize() {
    data.title ??= 'Untitled Novel';
    // Part 7c: a book may carry its own spell check language. Anything unknown is dropped (the default applies).
    if (!(emw.SPELL_LANGUAGES || []).some((l) => l.id === data.spellLanguage)) delete data.spellLanguage;
    // Part 7f: the page font and size for the whole book. Only validated when present, so books saved before
    // this part are not rewritten just by being opened; empty values mean "use the defaults in Settings".
    if (data.typography !== undefined) {
      const t = data.typography && typeof data.typography === 'object' ? data.typography : {};
      data.typography = {
        font: typeof t.font === 'string' ? t.font.replace(/[\u0000-\u001f"\\;{}]/g, '').trim().slice(0, 100) : '',
        size: Number.isInteger(t.size) && t.size >= 8 && t.size <= 96 ? t.size : null
      };
    }
    if (!Array.isArray(data.plotlines)) data.plotlines = [];
    if (!data.plotlines.length) data.plotlines.push({ id: uid(), name: 'Main Plot', color: '#e8caa4' });
    if (!Array.isArray(data.chapters)) data.chapters = [];
    if (!data.chapters.length) data.chapters.push(blankChapter());
    // Darlings: older saves have none. Drop anything that could not be restored or listed.
    if (!Array.isArray(data.darlings)) data.darlings = [];
    data.darlings = data.darlings
      .filter((d) => d && typeof d.id === 'string' && typeof d.kind === 'string')
      .map((d) => Object.assign({ label: '', origin: 'manuscript', createdAt: 0, preview: '', restore: {}, payload: {} }, d));

    data.categories = data.categories || {};
    for (const kind of KINDS) {
      if (!Array.isArray(data.categories[kind]) || !data.categories[kind].length) {
        data.categories[kind] = DEFAULT_CATEGORIES[kind].map((name) => ({ id: uid(), name }));
      }
      if (!Array.isArray(data[kind])) data[kind] = [];
    }
    for (const kind of KINDS) {
      const cats = new Set(data.categories[kind].map((c) => c.id));
      data[kind] = data[kind].map((e) => Object.assign(entityDefaults[kind](), e));
      for (const e of data[kind]) if (!cats.has(e.category)) e.category = '';
    }

    // Older saves kept names as text on scenes; turn them into real characters, places and tags.
    const ensure = (kind, v) => {
      if (data[kind].some((e) => e.id === v)) return v;
      const found = data[kind].find((e) => e.name.toLowerCase() === String(v).toLowerCase());
      if (found) return found.id;
      const e = Object.assign(entityDefaults[kind](), { id: uid(), name: String(v), category: data.categories[kind][0].id });
      data[kind].push(e);
      return e.id;
    };

    const first = data.plotlines[0].id;
    const known = new Set(data.plotlines.map((p) => p.id));
    for (const ch of data.chapters) {
      ch.title = /^Chapter \d+$/.test(ch.title || '') ? '' : (ch.title || '');
      delete ch.words;   // chapters no longer have text; their count is the sum of their scenes
      ch.synopsis ??= '';
      ch.dropcap = Object.assign(dropcapDefaults(), ch.dropcap);
      ch.scenes = (ch.scenes || []).map((raw) => {
        const s = Object.assign(blankScene(first), raw, known.has(raw.plotline) ? {} : { plotline: first });
        for (const kind of ['characters', 'places', 'tags']) {
          s[kind] = [...new Set((Array.isArray(s[kind]) ? s[kind] : []).map((v) => ensure(kind, v)))];
        }
        s.noteIds = (Array.isArray(s.noteIds) ? s.noteIds : []).filter((id) => data.notes.some((n) => n.id === id));
        if (typeof s.notes === 'string') {
          if (s.notes.trim()) {
            const note = Object.assign(entityDefaults.notes(), {
              id: uid(), name: `${s.title || 'Scene'} notes`, preview: s.notes.slice(0, 120),
              legacy: s.notes, category: data.categories.notes[0].id
            });
            data.notes.push(note);
            s.noteIds.push(note.id);
          }
          delete s.notes;
        }
        return s;
      });
    }
  }

  // Saves from before chapters became folders (schema < 2) may hold text in the chapter itself.
  // normalize() drops the chapter's `words`, so remember what the migration needs first.
  let migration = null;
  function load(raw) {
    data = raw;
    migration = (Number(data.schema) || 1) < 2
      ? (Array.isArray(data.chapters) ? data.chapters : []).map((c) => ({ id: c.id, words: Number(c.words) || 0 }))
      : null;
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
  const entity = (kind, id) => data[kind].find((e) => e.id === id) || null;
  const chapterWords = (ch) => ch.scenes.reduce((n, s) => n + s.words, 0);
  const totalWords = () => data.chapters.reduce((n, c) => n + chapterWords(c), 0);

  // The drop cap belongs to the first paragraph of a chapter: the first scene that has text,
  // otherwise the first scene, otherwise nobody.
  const dropcapOwner = (ch) => {
    const s = ch.scenes.find((x) => x.words > 0) || ch.scenes[0];
    return s ? s.id : null;
  };

  // Scenes that reference a character, place, note or tag.
  const scenesWith = (kind, id) => {
    const f = SCENE_FIELD[kind];
    const out = [];
    for (const chapter of data.chapters) for (const scene of chapter.scenes) if (scene[f].includes(id)) out.push({ scene, chapter });
    return out;
  };

  // ---- undo machinery --------------------------------------------------------
  function record(before, label, opts) {
    const now = Date.now();
    if (opts.coalesce && opts.coalesce === lastKey && now - lastTime < COALESCE_MS && undoStack.length) {
      lastTime = now; redoStack.length = 0; return;
    }
    undoStack.push({ json: before, label });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    lastKey = opts.coalesce || null;
    lastTime = now;
  }

  // Calls made inside another commit join it, so a compound action is one undo step.
  function commit(label, fn, opts = {}) {
    if (depth > 0) return fn();
    const before = JSON.stringify(data);
    let result;
    depth++;
    try { result = fn(); } finally { depth--; }
    if (JSON.stringify(data) === before) return result;
    record(before, label, opts);
    emit({ label });
    return result;
  }

  // Word counts come from the text files, so undo must not roll them back.
  function restore(json) {
    const words = new Map();
    for (const c of data.chapters) for (const s of c.scenes) words.set(s.id, s.words);
    // Text darlings are cut from the editor, whose own undo the store knows nothing about. Rolling
    // them back here could leave text that is in neither the scene nor Darlings, so they are kept.
    const textDarlings = (data.darlings || []).filter((d) => d.kind === 'text');
    data = JSON.parse(json);
    data.darlings = (data.darlings || []).filter((d) => d.kind !== 'text').concat(textDarlings)
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const c of data.chapters) for (const s of c.scenes) if (words.has(s.id)) s.words = words.get(s.id);
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

  // The book's own spell check language; null goes back to the default in Settings. One undo step.
  const setSpellLanguage = (id) => commit('spell check language', () => {
    if (id) data.spellLanguage = id; else delete data.spellLanguage;
  });

  // Part 7f: the book's page font and size (what the ribbon changes). '' and null mean the app defaults.
  const typography = () => ({ font: (data.typography && data.typography.font) || '', size: (data.typography && data.typography.size) || null });
  const setTypography = (patch, opts) => commit('page font', () => {
    const now = typography();
    const next = { font: 'font' in patch ? String(patch.font || '').replace(/[\u0000-\u001f"\\;{}]/g, '').trim().slice(0, 100) : now.font,
      size: 'size' in patch ? (Number.isInteger(patch.size) && patch.size >= 8 && patch.size <= 96 ? patch.size : null) : now.size };
    data.typography = next;
  }, opts);

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
    const p = { id: uid(), name: name || `Plotline ${data.plotlines.length + 1}`, color: randomColor(data.plotlines.map((x) => x.color)) };
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

  // ---- characters, places, notes, tags ----------------------------------------
  const addEntity = (kind, init = {}) => commit(`add ${KIND_ONE[kind]}`, () => {
    const e = Object.assign(entityDefaults[kind](), init, { id: uid() });
    if (!data.categories[kind].some((c) => c.id === e.category)) e.category = data.categories[kind][0]?.id || '';
    data[kind].push(e);
    return e.id;
  });

  const updateEntity = (kind, id, patch, opts) => commit(`edit ${KIND_ONE[kind]}`, () => {
    const e = entity(kind, id);
    if (e) Object.assign(e, patch);
  }, opts);

  // Changes that are measured rather than chosen (like a note's preview) are not undo steps.
  function setQuiet(kind, id, patch) {
    const e = entity(kind, id);
    if (!e) return;
    Object.assign(e, patch);
    emit({ label: 'quiet', quiet: true });
  }

  const deleteEntity = (kind, id) => commit(`delete ${KIND_ONE[kind]}`, () => {
    const i = data[kind].findIndex((e) => e.id === id);
    if (i < 0) return false;
    data[kind].splice(i, 1);
    const f = SCENE_FIELD[kind];
    for (const ch of data.chapters) for (const s of ch.scenes) s[f] = s[f].filter((x) => x !== id);
    if (kind === 'tags') for (const k of ['characters', 'places', 'notes']) for (const e of data[k]) e.tags = e.tags.filter((x) => x !== id);
    return true;
  });

  const duplicateEntity = (kind, id) => commit(`duplicate ${KIND_ONE[kind]}`, () => {
    const e = entity(kind, id);
    if (!e) return null;
    const copy = JSON.parse(JSON.stringify(e));
    copy.id = uid();
    copy.name = (copy.name || '') + ' (copy)';
    data[kind].splice(data[kind].indexOf(e) + 1, 0, copy);
    return copy.id;
  });

  const addCategory = (kind, name = 'New category') => commit('add category', () => {
    const c = { id: uid(), name };
    data.categories[kind].push(c);
    return c.id;
  });
  const renameCategory = (kind, id, name) => commit('rename category', () => {
    const c = data.categories[kind].find((x) => x.id === id);
    if (c) c.name = name;
  });
  const deleteCategory = (kind, id) => commit('delete category', () => {
    data.categories[kind] = data.categories[kind].filter((c) => c.id !== id);
    for (const e of data[kind]) if (e.category === id) e.category = '';
  });
  const moveCategory = (kind, id, at) => commit('move category', () => {
    const list = data.categories[kind];
    const from = list.findIndex((c) => c.id === id);
    if (from < 0) return;
    const [c] = list.splice(from, 1);
    let pos = at;
    if (from < pos) pos--;
    list.splice(clamp(pos, list.length), 0, c);
  });

  // Word counts are measured, not edited, so they are not undo steps.
  function setWords(id, n) {
    const d = doc(id);
    if (!d || d.kind !== 'scene' || d.item.words === n) return false;
    d.item.words = n;
    return true;
  }

  // One-time upgrade: which chapters might hold their own text. Null when nothing to do.
  const migrationCandidates = () => (migration ? migration.map((m) => ({ ...m })) : null);

  // Turns each chapter's own text into a first scene (index 0, first plotline, no title, draft).
  // `items` is [{ chapterId, html }] for chapters that really had text. This is not an undo step,
  // and the old chapter file stays on disk as a backup. Returns [{ sceneId, html }] so the caller
  // can write each scene's file before persisting the index.
  function migrateChapters(items) {
    const made = [];
    for (const { chapterId, html } of items) {
      const ch = findChapter(chapterId);
      if (!ch || ch.migrated) continue;
      const scene = blankScene(data.plotlines[0].id);
      scene.status = 'draft';
      const tmp = new DOMParser().parseFromString(html, 'text/html');
      scene.words = ((tmp.body.textContent || '').match(/\S+/g) || []).length;
      ch.scenes.unshift(scene);
      ch.migrated = true;
      made.push({ sceneId: scene.id, html });
    }
    data.schema = 2;
    migration = null;
    return made;
  }

  // ---- darlings ----------------------------------------------------------------
  // Things the writer wants out of the way but not deleted. Long text is never copied into the
  // index: scene bodies, note bodies and thumbnails stay in their own files (keyed by the same
  // ids, which the app never deletes), so restoring is lossless. Only cut-out text, which has no
  // file of its own, gets one (`darling-<id>`, written by the caller before it calls us).
  const ENTITY_KIND = { character: 'characters', place: 'places', note: 'notes', tag: 'tags' };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const sceneName = (s) => (s.title || '').trim() || 'Untitled scene';
  const chapterName = (ch) => (ch.title || '').trim() || `Chapter ${data.chapters.indexOf(ch) + 1}`;
  const findDarling = (id) => data.darlings.find((d) => d.id === id) || null;
  const entKindOf = (v) => ENTITY_KIND[v] || (KINDS.includes(v) ? v : null);

  function darlingsFor({ origin, sceneId } = {}) {
    return data.darlings.filter((d) => (!origin || d.origin === origin) &&
      (!sceneId || (d.kind === 'text' && d.restore.sceneId === sceneId)));
  }
  const darlingCount = (origin) => darlingsFor({ origin }).length;

  // kind: text | scene | chapter | plotline | character | place | note | tag | category.
  // For `text`, id is the source scene and opts carries { id, preview, offset, anchor, block }.
  // For `category`, opts.entityKind says which list it belongs to. Returns the darling id, or null
  // when the item is missing or cannot leave (the last chapter and the last plotline stay).
  function sendToDarlings(kind, id, opts = {}) {
    const did = opts.id || uid();
    const make = (extra) => Object.assign({ id: did, createdAt: Date.now(), preview: '', restore: {}, payload: {} }, extra);
    const place = (rec) => { data.darlings.unshift(rec); return did; };
    const entKind = ENTITY_KIND[kind];

    if (kind === 'text') {
      const f = findScene(id);
      if (!f) return null;
      const preview = String(opts.preview || '').slice(0, 200);
      place(make({
        kind, label: preview.slice(0, 60).trim() || 'Text', origin: opts.origin || 'manuscript', preview,
        restore: {
          sceneId: id, chapterId: f.chapter.id, chapterIndex: data.chapters.indexOf(f.chapter),
          offset: Number(opts.offset) || 0, anchor: String(opts.anchor || ''), block: !!opts.block,
          from: `${chapterName(f.chapter)} › ${sceneName(f.scene)}`
        },
        payload: { file: 'darling-' + did }
      }));
      // Not an undo step: the editor owns undo for text (see restore()).
      emit({ label: 'send text to darlings' });
      return did;
    }

    return commit('send to darlings', () => {
      if (kind === 'scene') {
        const f = findScene(id);
        if (!f) return null;
        const ci = data.chapters.indexOf(f.chapter);
        const si = f.chapter.scenes.indexOf(f.scene);
        const from = chapterName(f.chapter);
        f.chapter.scenes.splice(si, 1);
        return place(make({
          kind, label: sceneName(f.scene), origin: opts.origin || 'manuscript', preview: (f.scene.description || '').slice(0, 200),
          restore: { chapterId: f.chapter.id, chapterIndex: ci, index: si, plotlineId: f.scene.plotline, from },
          payload: { scene: clone(f.scene) }
        }));
      }
      if (kind === 'chapter') {
        const ch = findChapter(id);
        if (!ch || data.chapters.length <= 1) return null;
        const label = chapterName(ch);
        const i = data.chapters.indexOf(ch);
        data.chapters.splice(i, 1);
        return place(make({
          kind, label, origin: opts.origin || 'manuscript',
          preview: `${ch.scenes.length} scene${ch.scenes.length === 1 ? '' : 's'}${ch.synopsis ? ' · ' + ch.synopsis.slice(0, 160) : ''}`,
          restore: { index: i }, payload: { chapter: clone(ch) }
        }));
      }
      if (kind === 'plotline') {
        const pl = findPlotline(id);
        if (!pl || data.plotlines.length <= 1) return null;
        const scenes = [];
        data.chapters.forEach((ch, ci) => ch.scenes.forEach((s, si) => {
          if (s.plotline === id) scenes.push({ scene: clone(s), chapterId: ch.id, chapterIndex: ci, index: si });
        }));
        const i = data.plotlines.indexOf(pl);
        data.plotlines.splice(i, 1);
        for (const ch of data.chapters) ch.scenes = ch.scenes.filter((s) => s.plotline !== id);
        return place(make({
          kind, label: pl.name, origin: opts.origin || 'timeline',
          preview: `${scenes.length} scene${scenes.length === 1 ? '' : 's'}`,
          restore: { index: i }, payload: { plotline: clone(pl), scenes }
        }));
      }
      if (entKind) {
        const i = data[entKind].findIndex((e) => e.id === id);
        if (i < 0) return null;
        const e = data[entKind][i];
        const field = SCENE_FIELD[entKind];
        // Remember every link before cutting it, so restore can put each one back.
        const sceneIds = [];
        for (const ch of data.chapters) for (const s of ch.scenes) if (s[field].includes(id)) sceneIds.push(s.id);
        const holders = {};
        if (entKind === 'tags') {
          for (const k of ['characters', 'places', 'notes']) holders[k] = data[k].filter((x) => x.tags.includes(id)).map((x) => x.id);
        }
        const cat = data.categories[entKind].find((c) => c.id === e.category);
        data[entKind].splice(i, 1);
        for (const ch of data.chapters) for (const s of ch.scenes) s[field] = s[field].filter((x) => x !== id);
        if (entKind === 'tags') for (const k of ['characters', 'places', 'notes']) for (const x of data[k]) x.tags = x.tags.filter((t) => t !== id);
        return place(make({
          kind, label: e.name || `Unnamed ${kind}`, origin: opts.origin || entKind, preview: String(e.short || e.preview || '').slice(0, 200),
          restore: { entityKind: entKind, index: i, categoryId: e.category, categoryName: cat ? cat.name : '', sceneIds, holders },
          payload: { entity: clone(e) }
        }));
      }
      if (kind === 'category') {
        const k = entKindOf(opts.entityKind);
        if (!k) return null;
        const list = data.categories[k];
        const i = list.findIndex((c) => c.id === id);
        if (i < 0) return null;
        const [cat] = list.splice(i, 1);
        const entityIds = data[k].filter((e) => e.category === id).map((e) => e.id);
        for (const e of data[k]) if (e.category === id) e.category = '';
        return place(make({
          kind, label: cat.name, origin: opts.origin || k, preview: `${entityIds.length} ${k}`,
          restore: { entityKind: k, index: i, entityIds }, payload: { category: clone(cat) }
        }));
      }
      return null;
    });
  }

  // Puts a darling back (everything except text, which needs the editor: see darlings.js).
  // Returns { show, notice } or { error }. Falls back sensibly when a parent is gone, and never
  // fails silently. One undo step.
  function restoreDarling(id) {
    const rec = findDarling(id);
    if (!rec) return { error: 'That darling no longer exists' };
    if (rec.kind === 'text') return { error: 'Text is restored through the editor' };
    const r = rec.restore;
    const p = rec.payload;
    return commit('restore from darlings', () => {
      const notes = [];
      let show = null;
      const taken = (v) => ({ error: `Cannot restore: ${v} already exists` });
      const cleanLinks = (s) => {
        for (const k of ['characters', 'places', 'tags']) s[k] = (s[k] || []).filter((x) => entity(k, x));
        s.noteIds = (s.noteIds || []).filter((x) => entity('notes', x));
        if (!findPlotline(s.plotline)) { s.plotline = data.plotlines[0].id; notes.push('its plotline no longer exists, so it moved to the first plotline'); }
      };
      const nearestChapter = () => data.chapters[clamp(r.chapterIndex || 0, data.chapters.length - 1)];

      if (rec.kind === 'scene') {
        const scene = clone(p.scene);
        if (findScene(scene.id)) return taken('a scene with this id');
        let ch = findChapter(r.chapterId);
        let at;
        if (ch) at = clamp(r.index, ch.scenes.length);
        else { ch = nearestChapter(); at = ch.scenes.length; notes.unshift('its chapter no longer exists, so it went to ' + chapterName(ch)); }
        cleanLinks(scene);
        ch.scenes.splice(at, 0, scene);
        show = { kind: 'scene', id: scene.id };
      } else if (rec.kind === 'chapter') {
        const ch = clone(p.chapter);
        if (findChapter(ch.id) || ch.scenes.some((s) => findScene(s.id))) return taken('this chapter or one of its scenes');
        ch.scenes.forEach(cleanLinks);
        data.chapters.splice(clamp(r.index, data.chapters.length), 0, ch);
        show = { kind: 'chapter', id: ch.id };
      } else if (rec.kind === 'plotline') {
        const pl = clone(p.plotline);
        if (findPlotline(pl.id) || p.scenes.some((x) => findScene(x.scene.id))) return taken('this plotline or one of its scenes');
        data.plotlines.splice(clamp(r.index, data.plotlines.length), 0, pl);
        const ordered = [...p.scenes].sort((a, b) => a.chapterIndex - b.chapterIndex || a.index - b.index);
        let moved = 0;
        for (const item of ordered) {
          const s = clone(item.scene);
          let ch = findChapter(item.chapterId);
          if (!ch) { ch = data.chapters[clamp(item.chapterIndex, data.chapters.length - 1)]; moved++; }
          cleanLinks(s);
          ch.scenes.splice(clamp(item.index, ch.scenes.length), 0, s);
        }
        if (moved) notes.push(`${moved} scene${moved === 1 ? '' : 's'} went to the nearest chapter because the original no longer exists`);
        show = { kind: 'plotline', id: pl.id };
      } else if (ENTITY_KIND[rec.kind]) {
        const k = r.entityKind;
        const e = clone(p.entity);
        if (data[k].some((x) => x.id === e.id)) return taken('this ' + rec.kind);
        if (!data.categories[k].some((c) => c.id === e.category)) {
          e.category = '';
          notes.push(`its category${r.categoryName ? ' “' + r.categoryName + '”' : ''} no longer exists, so it is uncategorised`);
        }
        if (Array.isArray(e.tags)) e.tags = e.tags.filter((t) => entity('tags', t));
        data[k].splice(clamp(r.index, data[k].length), 0, e);
        const field = SCENE_FIELD[k];
        let relinked = 0;
        for (const sid of r.sceneIds || []) {
          const f = findScene(sid);
          if (f && !f.scene[field].includes(e.id)) { f.scene[field].push(e.id); relinked++; }
        }
        for (const [hk, ids] of Object.entries(r.holders || {})) {
          for (const hid of ids) { const h = entity(hk, hid); if (h && !h.tags.includes(e.id)) h.tags.push(e.id); }
        }
        const lost = (r.sceneIds || []).length - relinked;
        if (lost > 0) notes.push(`${lost} scene${lost === 1 ? '' : 's'} it was attached to no longer exist${lost === 1 ? 's' : ''}`);
        show = { kind: rec.kind, id: e.id };
      } else if (rec.kind === 'category') {
        const k = r.entityKind;
        const list = data.categories[k];
        const cat = clone(p.category);
        if (list.some((c) => c.id === cat.id)) return taken('this category');
        list.splice(clamp(r.index, list.length), 0, cat);
        for (const eid of r.entityIds || []) {
          const e = entity(k, eid);
          // Only take back items that are still uncategorised; leave anything the writer has since filed elsewhere.
          if (e && !list.some((c) => c.id === e.category && c.id !== cat.id)) e.category = cat.id;
        }
        show = { kind: 'category', id: cat.id, entityKind: k };
      } else return { error: 'Unknown kind of darling' };

      data.darlings = data.darlings.filter((d) => d.id !== id);
      return { show, notice: notes.length ? `Restored “${rec.label}”: ${notes.join('; ')}.` : '' };
    });
  }

  // Permanent removal from the list (the body files stay on disk). Returns the removed record so
  // the caller can offer Undo. Text darlings are outside store undo, so they have their own path.
  function deleteDarling(id) {
    const rec = findDarling(id);
    if (!rec) return null;
    if (rec.kind === 'text') { discardDarling(id); return rec; }
    commit('delete darling', () => { data.darlings = data.darlings.filter((d) => d.id !== id); });
    return rec;
  }
  // Removes a text darling without an undo step (after it is restored, or when the writer deletes it).
  function discardDarling(id) {
    const before = data.darlings.length;
    data.darlings = data.darlings.filter((d) => d.id !== id);
    if (data.darlings.length !== before) emit({ label: 'darlings' });
  }
  function readdDarling(rec) {
    if (!rec || findDarling(rec.id)) return;
    data.darlings.push(rec);
    data.darlings.sort((a, b) => b.createdAt - a.createdAt);
    emit({ label: 'darlings' });
  }
  // A count that changed without a data edit (a restored text changed a scene's words).
  const touch = () => emit({ label: 'refresh' });

  emw.store = {
    uid, touch, sendToDarlings, restoreDarling, deleteDarling, discardDarling, readdDarling, darlingsFor, darlingCount,
    findDarling, ENTITY_KIND,
    migrationCandidates, migrateChapters,
    get data() { return data; },
    load, on: (cb) => listeners.push(cb),
    find: { chapter: findChapter, scene: findScene, plotline: findPlotline },
    doc, entity, scenesWith, dropcapOwner, STATUSES, KINDS, KIND_ONE, SCENE_FIELD,
    chapterWords, totalWords, setWords,
    batch: (label, fn, opts) => commit(label, fn, opts),
    addChapter, insertChapterWithScene, updateChapter, deleteChapter, moveChapter,
    addScene, updateScene, deleteScene, moveScene, duplicateScene,
    addPlotline, updatePlotline, deletePlotline, movePlotline,
    addEntity, updateEntity, setQuiet, deleteEntity, duplicateEntity,
    addCategory, renameCategory, deleteCategory, moveCategory,
    setSpellLanguage, typography, setTypography,
    undo, redo, canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0
  };
})();
