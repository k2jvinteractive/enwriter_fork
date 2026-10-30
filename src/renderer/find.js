// Find and replace (part 7g). Ctrl+F opens a bar docked above the page in the Manuscript; in every other view it
// jumps to that view's own search box.
//
// Searching never changes the text. Matches are found in a plain-text copy of the scene (text nodes joined, with a
// line break between blocks, so a word that is half italic still matches) and painted with the CSS Custom Highlight
// API: two highlights, one for every match and one for the current match. No elements are wrapped around text.
// Scenes that are not open are read from their files in small async chunks and only counted.
//
// Replace goes through the editor (execCommand), so Ctrl+Z undoes one match at a time. Replace all that reaches
// other scenes edits their files after a "Before Replace All" snapshot (part 7e), and its Undo restores that snapshot.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const editorEl = document.getElementById('editor');
  const pageEl = document.getElementById('page');
  if (!editorEl || !pageEl) return;

  // ---- text model ------------------------------------------------------------------------------------
  const BLOCK = 'p,h1,h2,h3,h4,li,blockquote,div';
  const INLINE = /^(B|I|U|S|EM|STRONG|SPAN|FONT|SUB|SUP|A|MARK)$/;
  const WORD = /[\p{L}\p{N}_]/u;

  // One character in, one character out, so offsets in the folded text are offsets in the real text.
  const FOLD = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '‹': "'", '›': "'",
    '“': '"', '”': '"', '„': '"', '‟': '"', '«': '"', '»': '"', ' ': ' ' };
  function fold(s, matchCase) {
    let out = '';
    for (const ch of s) {
      const f = FOLD[ch] || ch;
      if (matchCase) { out += f; continue; }
      const low = f.toLowerCase();
      out += low.length === f.length ? low : f;
    }
    return out;
  }

  // The visible text of `root` with the text nodes that hold it. Blocks and <br> are separated by a line break,
  // which a search term never contains, so a match cannot run from one paragraph into the next.
  function model(root) {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const segs = [];
    let text = '';
    let last;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) { if (n.nodeName === 'BR') text += '\n'; continue; }
      if (!n.data) continue;
      const blk = n.parentElement ? n.parentElement.closest(BLOCK) : null;
      if (last !== undefined && blk !== last) text += '\n';
      last = blk;
      segs.push({ node: n, start: text.length });
      text += n.data;
    }
    return { segs, text };
  }

  function findAll(m, q, o) {
    const out = [];
    if (!q) return out;
    const hay = fold(m.text, o.matchCase);
    const needle = fold(q, o.matchCase);
    const wordStart = WORD.test(needle.charAt(0));
    const wordEnd = WORD.test(needle.charAt(needle.length - 1));
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
      if (o.whole) {
        const before = hay.slice(Math.max(0, i - 2), i);
        const after = hay.slice(i + needle.length, i + needle.length + 2);
        if ((wordStart && /[\p{L}\p{N}_]$/u.test(before)) || (wordEnd && /^[\p{L}\p{N}_]/u.test(after))) continue;
      }
      out.push(i);
    }
    return out;
  }

  // The segment that holds position `pos`. For an end position the segment may end exactly there.
  function locate(segs, pos, isEnd) {
    let lo = 0, hi = segs.length - 1, hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= pos) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit < 0) return null;
    if (isEnd && segs[hit].start === pos && hit > 0 && pos === segs[hit - 1].start + segs[hit - 1].node.data.length) hit--;
    return { i: hit, off: pos - segs[hit].start };
  }

  function rangeFor(m, start, len) {
    const a = locate(m.segs, start, false);
    const b = locate(m.segs, start + len, true);
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(m.segs[a.i].node, a.off);
    r.setEnd(m.segs[b.i].node, b.off);
    return r;
  }

  // Replaces one match inside a (detached) document by editing text nodes, so the formatting of the start of the
  // match carries over to the new text. Nodes left empty are removed.
  function replaceInModel(m, start, len, repl) {
    const a = locate(m.segs, start, false);
    const b = locate(m.segs, start + len, true);
    if (!a || !b) return;
    const sa = m.segs[a.i].node, sb = m.segs[b.i].node;
    const emptied = [];
    if (a.i === b.i) {
      sa.data = sa.data.slice(0, a.off) + repl + sa.data.slice(b.off);
    } else {
      sa.data = sa.data.slice(0, a.off) + repl;
      for (let k = a.i + 1; k < b.i; k++) { m.segs[k].node.data = ''; emptied.push(m.segs[k].node); }
      sb.data = sb.data.slice(b.off);
      if (!sb.data) emptied.push(sb);
    }
    if (!sa.data) emptied.push(sa);
    for (const n of emptied) {
      let p = n.parentNode;
      n.remove();
      while (p && p.parentNode && !p.childNodes.length && INLINE.test(p.nodeName)) { const up = p.parentNode; p.remove(); p = up; }
    }
  }

  const countWords = (root) => {
    const copy = root.cloneNode(true);
    copy.querySelectorAll('p,h1,h2,h3,h4,li,blockquote,div,br,hr').forEach((n) => n.after(' '));
    return (copy.textContent.match(/\S+/g) || []).length;
  };
  const parse = (html) => new DOMParser().parseFromString(html || '', 'text/html').body;

  // ---- state -------------------------------------------------------------------------------------------
  // Remembered for the session: closing the bar keeps the terms, and so does opening a different book.
  const opt = { q: '', matchCase: false, whole: false, scope: 'scene', repl: '' };
  let groups = [];        // scenes in scope that have matches: { id, label, count }
  let total = 0;
  let cur = null;         // { id, k }: the current match, k-th in that scene
  let eModel = null;      // the open scene's text model (the live editor)
  let eStarts = [];       // match starts in the open scene
  let eRanges = [];       // live ranges for those matches
  let token = 0;
  let wantPos = null;     // after a replace: choose the first match at or after this offset
  let busy = false;       // a replace is running; the editor's input events must not trigger a rescan
  let navigating = false;
  const hasHL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  const failSafe = (fn) => { try { return fn(); } catch { return undefined; } };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const matchesOf = (n) => `${n.toLocaleString()} ${n === 1 ? 'match' : 'matches'}`;

  // The open scene, if the editor is what is showing.
  function openSceneId() {
    const d = emw.curDoc && emw.curDoc();
    return d && d.kind === 'scene' && emw.view() === 'manuscript' && !document.getElementById('page').inert ? d.item.id : null;
  }

  function scenesInScope() {
    if (!S.data) return [];
    const d = emw.curDoc && emw.curDoc();
    const label = (ch, sc) => `${ch.title.trim() || `Chapter ${S.data.chapters.indexOf(ch) + 1}`} · ${sc.title.trim() || 'Untitled scene'}`;
    const all = [];
    for (const ch of S.data.chapters) {
      if (opt.scope === 'chapter' && (!d || d.chapter !== ch)) continue;
      for (const sc of ch.scenes) all.push({ id: sc.id, label: label(ch, sc) });
    }
    if (opt.scope === 'scene') { const id = openSceneId(); return all.filter((s) => s.id === id); }
    return all;
  }

  // ---- the bar -----------------------------------------------------------------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const icon = (id) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'ic');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#' + id);
    s.append(u);
    return s;
  };
  function button(cls, label, content) {
    const b = el('button', cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    if (typeof content === 'string') b.textContent = content; else if (content) b.append(content);
    return b;
  }

  const bar = el('div', 'find-bar');
  bar.id = 'find-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'search');
  bar.setAttribute('aria-label', 'Find and replace');

  const row1 = el('div', 'fd-row');
  const expand = button('fd-btn fd-expand', 'Show replace', icon('i-chev'));
  expand.setAttribute('aria-expanded', 'false');
  const findIn = el('input', 'fd-input');
  findIn.type = 'text';
  findIn.placeholder = 'Find';
  findIn.setAttribute('aria-label', 'Find');
  findIn.spellcheck = false;
  findIn.autocomplete = 'off';
  const count = el('span', 'fd-count');
  count.setAttribute('role', 'status');
  const prev = button('fd-btn', 'Previous match (Shift+F3)', icon('i-up'));
  const next = button('fd-btn', 'Next match (F3)', icon('i-down'));
  const mcase = button('fd-btn fd-toggle', 'Match case', 'Aa');
  const whole = button('fd-btn fd-toggle', 'Whole word', 'W');
  mcase.setAttribute('aria-pressed', 'false');
  whole.setAttribute('aria-pressed', 'false');
  const scope = el('select', 'fd-scope');
  scope.setAttribute('aria-label', 'Where to search');
  scope.title = 'Where to search. Replace only changes the text of scenes: titles, synopses, notes and characters, places and tags are not touched.';
  for (const [v, t] of [['scene', 'This scene'], ['chapter', 'This chapter'], ['book', 'Whole manuscript']]) { const o = new Option(t, v); scope.append(o); }
  const close = button('fd-btn', 'Close (Escape)', icon('i-close'));
  row1.append(expand, findIn, count, prev, next, mcase, whole, scope, close);

  const row2 = el('div', 'fd-row fd-replace');
  row2.hidden = true;
  const replIn = el('input', 'fd-input');
  replIn.type = 'text';
  replIn.placeholder = 'Replace with';
  replIn.setAttribute('aria-label', 'Replace with');
  replIn.spellcheck = false;
  replIn.autocomplete = 'off';
  const replBtn = el('button', 'fd-act', 'Replace');
  replBtn.type = 'button';
  const replAll = el('button', 'fd-act', 'Replace all');
  replAll.type = 'button';
  row2.append(el('span', 'fd-pad'), replIn, replBtn, replAll);

  const list = el('div', 'fd-groups');
  list.hidden = true;
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Matches by scene');
  bar.append(row1, row2, list);
  pageEl.before(bar);

  function showReplace(on) {
    row2.hidden = !on;
    expand.setAttribute('aria-expanded', String(on));
    expand.setAttribute('aria-label', on ? 'Hide replace' : 'Show replace');
    expand.title = expand.getAttribute('aria-label');
    expand.classList.toggle('open', on);
  }

  // ---- highlights --------------------------------------------------------------------------------------
  function clearHighlights() {
    if (!hasHL) return;
    CSS.highlights.delete('find-all');
    CSS.highlights.delete('find-current');
  }

  function paint() {
    const openId = openSceneId();
    if (hasHL) {
      if (!bar.hidden && eRanges.length && openId) {
        CSS.highlights.set('find-all', new Highlight(...eRanges));
        const c = cur && cur.id === openId ? eRanges[cur.k] : null;
        if (c) { const h = new Highlight(c); h.priority = 1; CSS.highlights.set('find-current', h); } else CSS.highlights.delete('find-current');
      } else clearHighlights();
    }
    // counter
    if (!opt.q) count.textContent = '';
    else if (!total) count.textContent = 'No matches';
    else {
      let before = 0;
      for (const g of groups) { if (cur && g.id === cur.id) break; before += g.count; }
      count.textContent = cur ? `${before + cur.k + 1} of ${total.toLocaleString()}` : `${total.toLocaleString()} matches`;
    }
    // matches grouped by scene (only when the search reaches beyond one scene)
    const show = opt.scope !== 'scene' && groups.length > 0;
    list.hidden = !show;
    if (show) {
      list.replaceChildren(...groups.map((g) => {
        const b = el('button', 'fd-group');
        b.type = 'button';
        b.setAttribute('role', 'listitem');
        b.dataset.id = g.id;
        b.setAttribute('aria-current', String(!!cur && cur.id === g.id));
        b.append(el('span', 'fd-gname', g.label), el('span', 'fd-gn', g.count.toLocaleString()));
        return b;
      }));
    }
  }

  // ---- finding -------------------------------------------------------------------------------------------
  function scanEditor() {
    eModel = model(editorEl);
    eStarts = findAll(eModel, opt.q, opt);
    const len = opt.q.length;
    eRanges = eStarts.map((s) => rangeFor(eModel, s, len)).filter(Boolean);
    if (eRanges.length !== eStarts.length) eStarts = eStarts.slice(0, eRanges.length);
  }

  function caretOffset() {
    const s = getSelection();
    if (!eModel || !s.rangeCount || !editorEl.contains(s.anchorNode) || s.anchorNode.nodeType !== 3) return 0;
    const seg = eModel.segs.find((x) => x.node === s.anchorNode);
    return seg ? seg.start + s.anchorOffset : 0;
  }

  // Counts the scenes in scope. `reselect` moves the selection to the current match (typing in the find box);
  // a rescan caused by editing the text does not touch the writer's selection.
  async function recount({ reselect = false } = {}) {
    const my = ++token;
    const openId = openSceneId();
    if (!opt.q || !S.data) {
      groups = []; total = 0; cur = null; eStarts = []; eRanges = []; eModel = null;
      paint();
      return;
    }
    const scenes = scenesInScope();
    const out = [];
    const needle = opt.q;
    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      let n = 0;
      if (sc.id === openId) { scanEditor(); n = eStarts.length; }
      else {
        let html = '';
        try { html = (await emw.files.read(sc.id)) || ''; } catch { /* unreadable: counts as none */ }
        if (my !== token) return;   // a newer search took over
        if (html) n = findAll(model(parse(html)), needle, opt).length;
      }
      if (n) out.push({ id: sc.id, label: sc.label, count: n });
      if (i % 8 === 7) { await tick(); if (my !== token) return; }
    }
    if (my !== token) return;
    if (!openId || !scenes.some((s) => s.id === openId)) { eStarts = []; eRanges = []; eModel = null; }
    groups = out;
    total = out.reduce((n, g) => n + g.count, 0);

    const openGroup = out.find((g) => g.id === openId);
    if (wantPos !== null && openGroup) {
      const k = eStarts.findIndex((s) => s >= wantPos);
      cur = { id: openId, k: k < 0 ? 0 : k };
    } else if (cur && out.some((g) => g.id === cur.id && cur.k < g.count)) {
      /* the current match is still there */
    } else if (openGroup) {
      const at = caretOffset();
      const k = eStarts.findIndex((s) => s >= at);
      cur = { id: openId, k: k < 0 ? 0 : k };
    } else cur = out.length ? { id: out[0].id, k: 0 } : null;
    wantPos = null;
    paint();
    if (reselect && cur && cur.id === openId) selectCurrent();
  }

  function selectCurrent() {
    const openId = openSceneId();
    if (!cur || cur.id !== openId) return;
    const r = eRanges[cur.k];
    if (!r) return;
    const s = getSelection();
    const had = document.activeElement;
    s.removeAllRanges();
    s.addRange(r.cloneRange());
    // Putting a selection inside the editor moves focus there; the writer is still typing in the bar.
    if (had && had !== document.activeElement && bar.contains(had)) had.focus();
    const rect = r.getBoundingClientRect();
    const box = pageEl.getBoundingClientRect();
    if (rect.top < box.top + 40 || rect.bottom > box.bottom - 80) pageEl.scrollTop += rect.top - (box.top + box.height / 3);
  }

  // Opens another scene and waits until it is in the editor.
  async function openScene(id) {
    navigating = true;
    try {
      emw.actions.openScene(id);
      for (let i = 0; i < 100; i++) {
        const d = emw.curDoc && emw.curDoc();
        if (d && d.kind === 'scene' && d.item.id === id && openSceneId() === id) break;
        await tick();
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally { navigating = false; }
  }

  // Makes `cur` the selected match, opening its scene first when it lives in another one.
  async function goTo() {
    if (!cur) return;
    const had = bar.contains(document.activeElement) ? document.activeElement : null;
    if (cur.id !== openSceneId()) {
      const want = { ...cur };
      await openScene(cur.id);
      cur = want;
      scanEditor();
      if (cur.k >= eRanges.length) cur.k = Math.max(0, eRanges.length - 1);
    }
    paint();
    selectCurrent();
    if (had) had.focus();   // opening a scene focuses the editor; the writer is still typing in the bar
  }

  function step(dir) {
    if (!total) return;
    let flat = 0;
    for (const g of groups) { if (cur && g.id === cur.id) break; flat += g.count; }
    flat = (flat + (cur ? cur.k : -1) + dir + total) % total;
    for (const g of groups) {
      if (flat < g.count) { cur = { id: g.id, k: flat }; break; }
      flat -= g.count;
    }
    return goTo();
  }

  // ---- replacing ------------------------------------------------------------------------------------------
  // Smart text would turn a one-character replacement like " into a curly quote; replacements are typed exactly.
  function plainInsert(fn) {
    const t = emw.smartText && emw.smartText.settings;
    const keep = t ? { quotes: t.quotes, ellipsis: t.ellipsis } : null;
    if (t) { t.quotes = false; t.ellipsis = false; }
    try { return fn(); } finally { if (t) { t.quotes = keep.quotes; t.ellipsis = keep.ellipsis; } }
  }
  function putText(range, text) {
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
    if (text === '') document.execCommand('delete'); else document.execCommand('insertText', false, text);
  }

  async function replaceOne() {
    if (!cur || busy) return;
    busy = true;
    try {
      const had = document.activeElement;
      if (cur.id !== openSceneId()) await goTo();
      const r = eRanges[cur.k];
      if (!r) return;
      const start = eStarts[cur.k];
      editorEl.focus();
      plainInsert(() => putText(r, opt.repl));
      if (had && had !== editorEl) had.focus();
      wantPos = start + opt.repl.length;
    } finally { busy = false; }
    await recount({ reselect: true });
  }

  // Every match in the open scene, last first so earlier positions stay valid. Each one is its own undo step.
  function replaceAllInEditor() {
    scanEditor();
    const ranges = eRanges.slice();
    editorEl.focus();
    plainInsert(() => { for (let i = ranges.length - 1; i >= 0; i--) putText(ranges[i], opt.repl); });
    return ranges.length;
  }

  async function replaceAllMatches() {
    if (!total || busy) return;
    busy = true;
    const had = document.activeElement;
    try {
      const openId = openSceneId();
      const others = groups.filter((g) => g.id !== openId);
      if (!others.length) {
        const n = replaceAllInEditor();
        if (had && had !== editorEl) had.focus();
        emw.toast(`Replaced ${matchesOf(n)}. Ctrl+Z undoes them one at a time.`, { ms: 6000 });
        return;
      }
      // Other scenes are edited in their files, so first make a way back.
      const snap = emw.snapshots ? await emw.snapshots.auto('before-replace-all', 'Before Replace All') : null;
      if (!snap) { emw.toast('Could not take a safety snapshot, so nothing was replaced.', { ms: 7000 }); return; }
      let matches = 0, scenes = 0;
      for (const g of groups) {
        if (g.id === openId) { matches += replaceAllInEditor(); scenes++; continue; }
        let html = '';
        try { html = (await emw.files.read(g.id)) || ''; } catch { continue; }
        const body = parse(html);
        const m = model(body);
        const starts = findAll(m, opt.q, opt);
        if (!starts.length) continue;
        for (let i = starts.length - 1; i >= 0; i--) replaceInModel(m, starts[i], opt.q.length, opt.repl);
        try { await emw.files.write(g.id, body.innerHTML); } catch { continue; }
        S.setWords(g.id, countWords(body));
        matches += starts.length;
        scenes++;
        await tick();
      }
      if (had && had !== editorEl) had.focus();
      emw.toast(`Replaced ${matchesOf(matches)} in ${plural(scenes, 'scene')}`, {
        ms: 12000,
        action: { label: 'Undo', run: () => emw.snapshots.restore(snap, { undo: true }) }
      });
    } catch {
      emw.toast('Replace all stopped part way. Use Snapshots in Darlings to go back if needed.', { ms: 8000 });
    } finally { busy = false; }
    await recount();
  }

  // ---- opening and closing ---------------------------------------------------------------------------------
  function selectedSeed() {
    const s = getSelection();
    if (!s.rangeCount || s.isCollapsed || !editorEl.contains(s.anchorNode)) return '';
    const t = s.toString();
    return t.length <= 100 && !/[\n\r]/.test(t) ? t : '';
  }

  function openBar({ replace = false } = {}) {
    const seed = selectedSeed();
    if (seed) opt.q = seed;
    bar.hidden = false;
    findIn.value = opt.q;
    replIn.value = opt.repl;
    mcase.setAttribute('aria-pressed', String(opt.matchCase));
    whole.setAttribute('aria-pressed', String(opt.whole));
    scope.value = opt.scope;
    if (replace) showReplace(true);
    (replace && !seed && opt.q ? replIn : findIn).focus();
    (replace && !seed && opt.q ? replIn : findIn).select();
    recount({ reselect: !!seed });
  }

  function closeBar() {
    if (bar.hidden) return;
    const openId = openSceneId();
    const r = cur && cur.id === openId ? eRanges[cur.k] : null;
    const keep = r ? r.cloneRange() : null;
    bar.hidden = true;
    token++;
    clearHighlights();
    eRanges = []; eStarts = [];
    if (openId) {
      editorEl.focus();
      if (keep) { const s = getSelection(); s.removeAllRanges(); s.addRange(keep); }
    }
  }

  // ---- other views --------------------------------------------------------------------------------------------
  function focusSearch() {
    const v = emw.view();
    let t = null;
    if (v === 'timeline') t = document.getElementById('tl-search');
    else if (v === 'darlings') t = document.getElementById('dl-search');
    else if (['characters', 'places', 'notes', 'tags'].includes(v)) t = document.querySelector(`#view-${v} .ev-filter`);
    else if (v === 'home') {
      t = document.querySelector('#view-home [tabindex="0"]') || document.querySelector('#view-home .cover');
      if (t) t.focus();
      return;
    }
    if (t) { t.focus(); if (t.select) t.select(); }
  }

  const noModal = () => !document.querySelector('dialog[open]');
  const inManuscript = () => emw.view() === 'manuscript';

  function doFind(replace) {
    if (!noModal()) return;
    if (!inManuscript()) { focusSearch(); return; }
    if (bar.hidden) { openBar({ replace }); return; }
    if (replace) showReplace(true);
    const t = replace && opt.q ? replIn : findIn;
    const seed = selectedSeed();
    if (seed && !replace) { opt.q = seed; findIn.value = seed; recount({ reselect: true }); }
    t.focus();
    t.select();
  }

  function stepFromKey(dir) {
    if (!inManuscript() || !noModal()) return;
    if (bar.hidden) {
      if (!opt.q) { openBar(); return; }
      openBar();
      recount().then(() => step(dir));
      return;
    }
    step(dir);
  }

  Object.assign(emw.actions, {
    find: () => doFind(false),
    replace: () => doFind(true),
    findNext: () => stepFromKey(1),
    findPrevious: () => stepFromKey(-1)
  });
  emw.keys.register({ id: 'find', label: 'Find', group: 'Edit', keys: 'Ctrl+F', when: noModal });
  emw.keys.register({ id: 'findNext', label: 'Find next', group: 'Edit', keys: 'F3', when: () => inManuscript() && noModal() });
  emw.keys.register({ id: 'findPrevious', label: 'Find previous', group: 'Edit', keys: 'Shift+F3', when: () => inManuscript() && noModal() });
  emw.keys.register({ id: 'replace', label: 'Replace', group: 'Edit', keys: 'Ctrl+H', when: noModal });

  // ---- events --------------------------------------------------------------------------------------------------
  let typingTimer = 0;
  findIn.addEventListener('input', () => {
    opt.q = findIn.value;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => recount({ reselect: true }), 90);   // wide scopes read files: wait for a pause
  });
  replIn.addEventListener('input', () => { opt.repl = replIn.value; });
  const keysIn = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.target === replIn) replaceOne(); else step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBar(); }
  };
  findIn.addEventListener('keydown', keysIn);
  replIn.addEventListener('keydown', keysIn);
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  expand.addEventListener('click', () => showReplace(row2.hidden));
  close.addEventListener('click', closeBar);
  mcase.addEventListener('click', () => { opt.matchCase = !opt.matchCase; mcase.setAttribute('aria-pressed', String(opt.matchCase)); cur = null; recount({ reselect: true }); });
  whole.addEventListener('click', () => { opt.whole = !opt.whole; whole.setAttribute('aria-pressed', String(opt.whole)); cur = null; recount({ reselect: true }); });
  scope.addEventListener('change', () => { opt.scope = scope.value; cur = null; recount({ reselect: true }); });
  replBtn.addEventListener('click', replaceOne);
  replAll.addEventListener('click', replaceAllMatches);
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.fd-group');
    if (!b) return;
    cur = { id: b.dataset.id, k: 0 };
    goTo();
  });
  // Escape anywhere in the bar closes it (the buttons and the scope list too).
  bar.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeBar(); } });

  // Keep the matches in step with the text and with what is open.
  let editTimer = 0;
  emw.editor.onChange(() => {
    if (bar.hidden || busy || !opt.q) return;
    clearTimeout(editTimer);
    editTimer = setTimeout(() => recount(), 200);
  });
  document.addEventListener('emw:doc', () => { if (!bar.hidden && !navigating) recount(); });
  emw.onView((name) => { if (name !== 'manuscript') clearHighlights(); else if (!bar.hidden) recount(); });
  emw.book.onSwitch(() => { bar.hidden = true; token++; cur = null; groups = []; total = 0; eRanges = []; eStarts = []; clearHighlights(); });
  emw.find = { open: openBar, close: closeBar };
})();
