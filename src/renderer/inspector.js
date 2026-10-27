// Inspector extras: characters and places detected in what you are writing,
// and the notes attached to the current scene.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const editor = emw.editor;
  const $ = (s) => document.querySelector(s);

  const hosts = { characters: $('#det-characters'), places: $('#det-places') };
  const hintEl = $('#det-hint');
  const notesHost = $('#insp-notes');

  // ---- name matching --------------------------------------------------------------
  // A character matches on: their full name, any alias, or any single capitalised part of
  // their name ("John" for "John MC"). Single words must match capitalisation exactly, so a
  // character called "Mage" isn't found in every "mage". Longer names and aliases ignore case.
  // If a part is shared (two Nightrichs), it only counts for whoever was also named in full.
  const STOP = new Set(['the', 'of', 'and', 'von', 'van', 'der', 'den', 'sir', 'lord', 'lady', 'mr', 'mrs', 'ms', 'dr', 'miss']);
  const matchers = {};

  function buildMatcher(kind) {
    const entries = new Map();   // token -> { strong:Set, weak:Set, multi }
    const add = (token, id, strong) => {
      const multi = /\s/.test(token);
      const key = multi ? token.toLowerCase().replace(/\s+/g, ' ') : token;
      if (!entries.has(key)) entries.set(key, { strong: new Set(), weak: new Set(), multi, token });
      entries.get(key)[strong ? 'strong' : 'weak'].add(id);
    };
    for (const e of S.data[kind]) {
      const name = e.name.trim();
      if (name.length >= 2) add(name, e.id, true);
      for (const a of e.aliases || []) if (a.trim().length >= 2) add(a.trim(), e.id, true);
      const words = name.split(/\s+/);
      if (words.length > 1) {
        for (const w of words) {
          const clean = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
          if (clean.length >= 3 && !STOP.has(clean.toLowerCase()) && /^\p{Lu}/u.test(clean)) add(clean, e.id, false);
        }
      }
    }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const edge = (body) => `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`;
    const byLen = (a, b) => b.length - a.length;
    const multi = [...entries.values()].filter((x) => x.multi).map((x) => x.token).sort(byLen);
    const single = [...entries.values()].filter((x) => !x.multi).map((x) => x.token).sort(byLen);
    return {
      entries,
      ci: multi.length ? new RegExp(edge(multi.map(esc).join('|')), 'giu') : null,
      cs: single.length ? new RegExp(edge(single.map(esc).join('|')), 'gu') : null
    };
  }

  function matcherFor(kind) {
    const sig = S.data[kind].map((e) => `${e.id}|${e.name}|${(e.aliases || []).join('~')}`).join('\n');
    if (!matchers[kind] || matchers[kind].sig !== sig) matchers[kind] = Object.assign(buildMatcher(kind), { sig });
    return matchers[kind];
  }

  function detect(kind, text) {
    if (!S.data[kind].length || !text.trim()) return [];
    const m = matcherFor(kind);
    const hits = [];   // { entry, index }
    for (const re of [m.ci, m.cs]) {
      if (!re) continue;
      re.lastIndex = 0;
      for (let r = re.exec(text); r; r = re.exec(text)) {
        const key = /\s/.test(r[0]) ? r[0].toLowerCase().replace(/\s+/g, ' ') : r[0];
        const entry = m.entries.get(key);
        if (entry) hits.push({ entry, index: r.index });
      }
    }
    const confident = new Set();
    for (const h of hits) if (h.entry.strong.size) h.entry.strong.forEach((id) => confident.add(id));
    const found = new Map();
    const note = (id, index, maybe) => {
      const f = found.get(id) || { id, count: 0, first: index, maybe: true };
      f.count++;
      f.first = Math.min(f.first, index);
      if (!maybe) f.maybe = false;
      found.set(id, f);
    };
    for (const { entry, index } of hits) {
      if (entry.strong.size) { entry.strong.forEach((id) => note(id, index, false)); continue; }
      const ids = [...entry.weak];
      const sure = ids.filter((id) => confident.has(id));
      if (sure.length) sure.forEach((id) => note(id, index, false));
      else if (ids.length === 1) ids.forEach((id) => note(id, index, false));
      else ids.forEach((id) => note(id, index, true));
    }
    return [...found.values()].sort((a, b) => a.first - b.first);
  }

  // ---- detected list --------------------------------------------------------------------
  const currentScene = () => { const d = emw.curDoc?.(); return d && d.kind === 'scene' ? d.item : null; };

  function renderGroup(kind, host, text, scene) {
    const found = detect(kind, text);
    const field = S.SCENE_FIELD[kind];
    const attached = scene ? scene[field] : [];
    const rows = found.map((f) => ({ ...f, attached: attached.includes(f.id) }));
    for (const id of attached) if (!rows.some((r) => r.id === id) && S.entity(kind, id)) rows.push({ id, count: 0, maybe: false, attached: true });
    host.replaceChildren(...rows.map((r) => {
      const e = S.entity(kind, r.id);
      const row = document.createElement('div');
      row.className = 'det-row';
      const av = document.createElement('span');
      av.className = `av ${kind}`;
      av.textContent = (e.name.trim()[0] || '?').toUpperCase();
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'det-name';
      name.textContent = e.name || `Unnamed ${S.KIND_ONE[kind]}`;
      name.title = `Open ${e.name}`;
      name.addEventListener('click', () => emw.openEntity(kind, r.id));
      const meta = document.createElement('span');
      meta.className = 'det-meta';
      meta.textContent = r.count ? (r.maybe ? 'maybe' : `×${r.count}`) : 'not mentioned';
      if (r.maybe) meta.title = 'This name is shared by more than one character or place';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'det-btn' + (r.attached ? ' on' : '');
      btn.textContent = r.attached ? 'Remove' : 'Add';
      btn.disabled = !scene;
      btn.title = scene ? '' : 'Open a scene to attach it';
      btn.addEventListener('click', () => {
        const now = S.find.scene(scene.id).scene[field];
        S.updateScene(scene.id, { [field]: r.attached ? now.filter((x) => x !== r.id) : [...now, r.id] });
      });
      row.append(av, name, meta, btn);
      return row;
    }));
    return rows.length;
  }

  function renderDetected() {
    if (!S.data || !emw.curDoc?.()) return;
    const text = editor.text();
    const scene = currentScene();
    const n = renderGroup('characters', hosts.characters, text, scene) + renderGroup('places', hosts.places, text, scene);
    if (n) hintEl.hidden = true;
    else {
      hintEl.hidden = false;
      hintEl.textContent = S.data.characters.length || S.data.places.length
        ? 'No known characters or places in this text yet.'
        : 'Add characters and places in their tabs and they will be recognised here as you write.';
    }
    if (emw.curDoc().kind === 'chapter' && n) hintEl.hidden = false, hintEl.textContent = 'Open a scene to attach these to it.';
  }

  // ---- notes tab ----------------------------------------------------------------------------
  const notesHint = document.createElement('p');
  notesHint.className = 'hint';
  const notesField = emw.linkField(document.createElement('div'), {
    kind: 'notes', list: true,
    get: () => currentScene()?.noteIds || [],
    set: (ids) => { const s = currentScene(); if (s) S.updateScene(s.id, { noteIds: ids }); },
    onCreated: (id) => emw.toast('Note created and attached', { action: { label: 'Open', run: () => emw.openEntity('notes', id) } })
  });
  notesHost.append(notesHint, notesField.host);

  function renderNotes() {
    if (!S.data || !emw.curDoc?.()) return;
    const scene = currentScene();
    notesField.host.hidden = !scene;
    notesHint.hidden = !!scene;
    notesHint.textContent = 'Notes are attached to scenes. Open a scene to see or add its notes.';
    if (scene) notesField.refresh();
  }

  document.querySelectorAll('.insp-tabbar button').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.insp-tabbar button').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $('#insp-notes').hidden = tab.dataset.tab !== 'notes';
    $('#insp-darlings').hidden = tab.dataset.tab !== 'darlings';
  }));

  // ---- when to refresh ------------------------------------------------------------------------
  let timer = 0;
  const soon = (ms = 450) => { clearTimeout(timer); timer = setTimeout(() => { renderDetected(); renderNotes(); }, ms); };
  editor.onChange(() => soon(600));
  S.on(() => soon(80));
  document.addEventListener('emw:doc', () => soon(0));
})();
