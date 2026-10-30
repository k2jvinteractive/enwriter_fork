// Family trees, canvas part 1 (part 7j1): the SVG canvas, generation bands, character nodes, adding and
// removing members. The data lives in the store (families[].members); this file only draws it and
// turns gestures into store calls. Part 7j2 adds links and lines (`emw.familyLinks`), 7j3 adds layout,
// export and details.
// Hooks for those parts: `.fc-node` groups carry `data-id`; `emw.familyCanvas.menuExtras` collects
// functions that return extra items for the ≡ menu; `emw.familyCanvas.layer` is the SVG group that
// sits between the bands and the nodes (lines go there).
// What 7j2 uses: `emw.familyCanvas.view()` (the live view, so a rubber band can be drawn in screen
// coordinates) and `setNodeLabel(id, text)` (an aria-label that names a node's relations).
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const ft = emw.familyTree;
  if (!ft) return;
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (s, r = document) => r.querySelector(s);

  const BAND_H = 160, MIN_BANDS = 5, R = 28, GRID = 8, SPAN = 8000, NAME_MAX = 18;
  const Z_MIN = 0.1, Z_MAX = 2, Z_STEP = 0.1;

  // The name pill under a node is sized from the same numbers the link labels use (S.FT_GEO), so both agree.
  const PILL_W = S.FT_GEO.PILL_W, PILL_H = S.FT_GEO.PILL_H, PILL_GAP = S.FT_GEO.PILL_GAP;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const sv = (tag, attrs, cls) => {
    const n = document.createElementNS(NS, tag);
    if (cls) n.setAttribute('class', cls);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    return n;
  };
  const btn = (cls, label, text) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (label) { b.setAttribute('aria-label', label); b.title = label; }
    return b;
  };
  const icon = (id) => { const s = sv('svg', { 'aria-hidden': 'true' }, 'ic'); s.append(sv('use', { href: '#' + id })); return s; };
  const snap = (v) => Math.round(v / GRID) * GRID;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const bandY = (gen) => gen * BAND_H + BAND_H / 2 - 12;   // circle centre; the name pill hangs below it
  const genAt = (y) => Math.max(0, Math.floor(y / BAND_H));

  // ---- state (view state only; the data is in the store) ----------------------------------------------
  let famId = '';
  let selChar = '';
  let z = 1, px = 0, py = 0;
  const views = new Map();        // family id -> { z, x, y } for this session
  const needFit = new Set();      // families that have not been fitted since they were first shown
  const thumbs = new Map();       // character id -> data URL ('' when none)
  let live = null, svg = null, world = null, bandsG = null, layer = null, nodesG = null;
  let zoomLabel = null, emptyEl = null;
  let spaceDown = false;
  let ro = null;
  const menuExtras = [];

  const family = () => S.family(famId);
  const charOf = (id) => (S.data && S.data.characters.find((c) => c.id === id)) || null;
  const nameOf = (c) => (c && c.name) || 'Unnamed character';

  // ---- the skeleton --------------------------------------------------------------------------------
  function mount() {
    if (live && live.isConnected) return;
    live = el('div', 'ft-canvas-live');
    live.tabIndex = 0;
    live.setAttribute('role', 'group');
    live.setAttribute('aria-label', 'Family tree canvas. Arrow keys pan, plus and minus zoom, 0 fits the tree to the window.');
    svg = sv('svg', { 'aria-hidden': 'false' }, 'fc-svg');
    const defs = sv('defs');
    const clip = sv('clipPath', { id: 'fc-clip' });
    clip.append(sv('circle', { cx: 0, cy: 0, r: R - 3 }));
    defs.append(clip);
    world = sv('g', {}, 'fc-world');
    bandsG = sv('g', {}, 'fc-bands');
    layer = sv('g', {}, 'fc-layer');
    nodesG = sv('g', {}, 'fc-nodes');
    world.append(bandsG, layer, nodesG);
    svg.append(defs, world);

    const add = btn('fc-add', 'Add character to this family');
    add.append(icon('i-plus'), el('span', '', 'Add character'));
    add.addEventListener('click', () => openPicker());

    emptyEl = el('p', 'fc-empty', 'No one is in this family yet. Add characters to place them on the tree.');

    const zoom = el('div', 'fc-zoom');
    zoom.setAttribute('role', 'group');
    zoom.setAttribute('aria-label', 'Zoom');
    const out = btn('fc-zbtn', 'Zoom out'); out.append(icon('i-minus'));
    const inn = btn('fc-zbtn', 'Zoom in'); inn.append(icon('i-plus'));
    zoomLabel = el('span', 'fc-zval', '100%');
    zoomLabel.setAttribute('role', 'status');
    const fit = btn('fc-zbtn fc-fit', 'Fit the tree to the window'); fit.append(icon('i-fit'), el('span', '', 'Fit'));
    out.addEventListener('click', () => zoomBy(-Z_STEP));
    inn.addEventListener('click', () => zoomBy(Z_STEP));
    fit.addEventListener('click', () => fitView());
    zoom.append(out, zoomLabel, inn, fit);

    const menu = btn('fc-menu', 'Family tree menu');
    menu.setAttribute('aria-haspopup', 'menu');
    menu.append(icon('i-menu'));
    menu.addEventListener('click', () => {
      const r = menu.getBoundingClientRect();
      // Opens upward: the button sits in the bottom corner.
      const items = menuItems();
      emw.menu(r.right - 190, Math.max(8, r.top - 8 - items.length * 32), items);
    });

    live.append(svg, add, emptyEl, zoom, menu);
    canvasEl().replaceChildren(live);
    bind();
    if (ro) ro.disconnect();
    try {
      ro = new ResizeObserver(() => { if (famId && needFit.has(famId) && live.clientWidth > 0) fitView(); });
      ro.observe(live);
    } catch { ro = null; /* without it Fit is still available by hand */ }
  }
  const canvasEl = () => ft.canvas;

  function menuItems() {
    const items = [{ label: 'Add character…', run: () => openPicker() }];
    for (const fn of menuExtras) { try { items.push(...fn()); } catch { /* an extra must not break the menu */ } }
    return items;
  }

  // ---- view transform ------------------------------------------------------------------------------
  function applyView(remember = true) {
    world.setAttribute('transform', `translate(${px} ${py}) scale(${z})`);
    zoomLabel.textContent = `${Math.round(z * 100)}%`;
    if (remember && famId) views.set(famId, { z, x: px, y: py });
  }
  function zoomTo(nz, cx, cy) {
    nz = clamp(Math.round(nz * 1000) / 1000, Z_MIN, Z_MAX);
    if (cx === undefined) { cx = live.clientWidth / 2; cy = live.clientHeight / 2; }
    px = cx - (cx - px) * (nz / z);
    py = cy - (cy - py) * (nz / z);
    z = nz;
    needFit.delete(famId);
    applyView();
  }
  const zoomBy = (d) => zoomTo(Math.round((z + d) * 10) / 10, undefined, undefined);

  function fitView() {
    const f = family();
    const w = live.clientWidth, h = live.clientHeight;
    if (!f || w <= 0 || h <= 0) return;
    needFit.delete(famId);
    if (!f.members.length) {
      z = 1; px = w / 2; py = 70;
      applyView();
      return;
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const m of f.members) {
      x0 = Math.min(x0, m.x - 60); x1 = Math.max(x1, m.x + 60);
      y0 = Math.min(y0, bandY(m.gen) - R - 12); y1 = Math.max(y1, bandY(m.gen) + R + 44);
    }
    const pad = 56;
    z = clamp(Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0), 1), Z_MIN, Z_MAX);
    px = w / 2 - ((x0 + x1) / 2) * z;
    py = h / 2 - ((y0 + y1) / 2) * z;
    applyView();
  }

  // The world point at the middle of what the writer sees.
  const viewCentre = () => ({ x: (live.clientWidth / 2 - px) / z, y: (live.clientHeight / 2 - py) / z });
  const toWorld = (e) => {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - px) / z, y: (e.clientY - r.top - py) / z };
  };

  // ---- drawing --------------------------------------------------------------------------------------
  function loadThumb(id) {
    if (thumbs.has(id)) return Promise.resolve(thumbs.get(id));
    return Promise.resolve(emw.files.read('thumb-' + id)).then((url) => { thumbs.set(id, url || ''); return url || ''; }, () => '');
  }

  function drawBands(f) {
    const top = Math.max(MIN_BANDS, f.members.reduce((n, m) => Math.max(n, m.gen + 2), 0));
    const rects = [];
    for (let g = 0; g < top; g++) {
      rects.push(sv('rect', { x: -SPAN, y: g * BAND_H, width: SPAN * 2, height: BAND_H }, 'fc-band ' + (g % 2 ? 'odd' : 'even')));
    }
    bandsG.replaceChildren(...rects);
  }

  function nodeEl(m, f) {
    const c = charOf(m.id);
    const g = sv('g', {}, 'fc-node');
    g.dataset.id = m.id;
    g.setAttribute('transform', `translate(${m.x} ${bandY(m.gen)})`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', nameOf(c));
    g.setAttribute('aria-pressed', String(m.id === selChar));
    const focus = sv('circle', { r: R + 6 }, 'fc-focus');
    const sel = sv('circle', { r: R + 4 }, 'fc-sel');
    const disc = sv('circle', { r: R }, 'fc-disc');
    const ring = sv('circle', { r: R }, 'fc-ring');
    g.append(focus, sel, disc);
    if (c && c.hasThumb) {
      const img = sv('image', { x: -(R - 3), y: -(R - 3), width: (R - 3) * 2, height: (R - 3) * 2, 'clip-path': 'url(#fc-clip)', preserveAspectRatio: 'xMidYMid slice' });
      g.append(img);
      loadThumb(m.id).then((url) => { if (url && img.isConnected) img.setAttribute('href', url); });
    } else {
      const u = sv('use', { href: '#i-person-silhouette', x: -16, y: -16, width: 32, height: 32 }, 'fc-sil');
      g.append(u);
    }
    g.append(ring);
    const full = nameOf(c);
    const shown = full.length > NAME_MAX ? full.slice(0, NAME_MAX - 1) + '…' : full;
    const w = Math.max(40, shown.length * 7.2 + 18);
    const pill = sv('rect', { x: -w / 2, y: R + 6, width: w, height: 20, rx: 10 }, 'fc-pill');
    const t = sv('text', { x: 0, y: R + 20, 'text-anchor': 'middle' }, 'fc-name');
    t.textContent = shown;
    const title = sv('title');
    title.textContent = full;
    g.append(pill, t, title);
    return g;
  }

  function render() {
    if (!live || !live.isConnected) return;
    const f = family();
    if (!f) return;
    svg.style.setProperty('--fc', f.color);
    const had = document.activeElement?.closest?.('.fc-node')?.dataset.id || '';
    if (selChar && !f.members.some((m) => m.id === selChar)) selChar = '';
    drawBands(f);
    nodesG.replaceChildren(...f.members.filter((m) => charOf(m.id)).map((m) => nodeEl(m, f)));
    emptyEl.hidden = f.members.length > 0;
    if (had && live.contains(document.activeElement) === false) {
      // The node that had focus was redrawn; give focus to its replacement (or the canvas if it is gone).
      const back = nodesG.querySelector(`.fc-node[data-id="${had}"]`);
      (back || live).focus({ preventScroll: true });
    }
  }

  function setSel(id) {
    selChar = id || '';
    nodesG.querySelectorAll('.fc-node').forEach((n) => n.setAttribute('aria-pressed', String(n.dataset.id === selChar)));
  }

  // ---- removing, opening ----------------------------------------------------------------------------------
  function removeMember(id) {
    const f = family();
    const c = charOf(id);
    if (!f || !f.members.some((m) => m.id === id)) return;
    S.removeFamilyMember(f.id, id);
    // Only the family is changed; the character stays in the Characters list.
    emw.toast(`Removed ${nameOf(c)} from ${f.name || 'this family'}`, { action: { label: 'Undo', run: () => { S.undo(); } } });
  }
  const openChar = (id) => emw.openEntity('characters', id);

  function nodeMenu(id, x, y) {
    setSel(id);
    emw.menu(x, y, [
      { label: 'Open character', run: () => openChar(id) },
      null,
      { label: 'Remove from family', danger: true, run: () => removeMember(id) }
    ]);
  }

  // ---- pointer: pan, zoom, drag ------------------------------------------------------------------------------
  let gesture = null;   // { kind: 'pan'|'node', ... }

  function bind() {
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const node = e.target.closest('.fc-node');
      if (node && !spaceDown) {
        const f = family();
        const m = f && f.members.find((n) => n.id === node.dataset.id);
        if (!m) return;
        setSel(m.id);
        const p = toWorld(e);
        gesture = { kind: 'node', id: m.id, el: node, ox: p.x - m.x, oy: p.y - bandY(m.gen), x: m.x, gen: m.gen, moved: false, sx: e.clientX, sy: e.clientY };
        svg.setPointerCapture(e.pointerId);
        return;
      }
      // Background (or Space held): pan.
      if (!node) setSel('');
      gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, px, py };
      live.classList.add('panning');
      svg.setPointerCapture(e.pointerId);
      live.focus({ preventScroll: true });
    });
    svg.addEventListener('pointermove', (e) => {
      if (!gesture) return;
      if (gesture.kind === 'pan') {
        px = gesture.px + (e.clientX - gesture.sx);
        py = gesture.py + (e.clientY - gesture.sy);
        needFit.delete(famId);
        applyView(false);
        return;
      }
      if (!gesture.moved && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) < 4) return;   // a click, not a drag
      gesture.moved = true;
      const p = toWorld(e);
      gesture.x = snap(p.x - gesture.ox);
      gesture.gen = genAt(p.y - gesture.oy + 12);   // the band holding the circle's centre (bandY is 12 above the band's middle)
      gesture.el.classList.add('dragging');
      gesture.el.setAttribute('transform', `translate(${gesture.x} ${bandY(gesture.gen)})`);
    });
    const end = (e) => {
      if (!gesture) return;
      const g = gesture;
      gesture = null;
      live.classList.remove('panning');
      try { svg.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (g.kind === 'pan') { applyView(); return; }
      g.el.classList.remove('dragging');
      if (g.moved) {
        const f = family();
        const m = f && f.members.find((n) => n.id === g.id);
        if (m && (m.x !== g.x || m.gen !== g.gen)) S.moveFamilyMember(f.id, g.id, g.x, g.gen);   // one commit = one undo step
        else render();
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);

    svg.addEventListener('dblclick', (e) => {
      const node = e.target.closest('.fc-node');
      if (node) openChar(node.dataset.id);
    });
    svg.addEventListener('contextmenu', (e) => {
      const node = e.target.closest('.fc-node');
      if (!node) return;
      e.preventDefault();
      nodeMenu(node.dataset.id, e.clientX, e.clientY);
    });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      if (e.ctrlKey) zoomTo(z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      else { px -= e.deltaX; py -= e.deltaY; needFit.delete(famId); applyView(); }
    }, { passive: false });

    live.addEventListener('keydown', onKey);
    live.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; live.classList.remove('space'); } });
    live.addEventListener('blur', () => { spaceDown = false; live.classList.remove('space'); }, true);
  }

  // ---- keyboard ----------------------------------------------------------------------------------------------
  function onKey(e) {
    const node = e.target.closest?.('.fc-node');
    const f = family();
    if (!f) return;
    if (node) {
      const id = node.dataset.id;
      const m = f.members.find((n) => n.id === id);
      if (!m) return;
      if (e.key === 'Enter') { e.preventDefault(); openChar(id); return; }
      if (e.key === ' ') { e.preventDefault(); setSel(selChar === id ? '' : id); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeMember(id); return; }
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const r = node.getBoundingClientRect();
        nodeMenu(id, r.left + r.width / 2, r.bottom);
        return;
      }
      if (e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        let { x, gen } = m;
        if (e.altKey) { if (e.key === 'ArrowUp') gen = Math.max(0, gen - 1); else if (e.key === 'ArrowDown') gen += 1; }
        else if (e.key === 'ArrowLeft') x -= GRID * (e.shiftKey ? 5 : 1);
        else if (e.key === 'ArrowRight') x += GRID * (e.shiftKey ? 5 : 1);
        if (x !== m.x || gen !== m.gen) S.moveFamilyMember(f.id, id, x, gen, { coalesce: `fam-move:${f.id}:${id}` });
        return;
      }
      return;
    }
    // On the canvas itself.
    if (e.target !== live) return;
    if (e.code === 'Space') { e.preventDefault(); spaceDown = true; live.classList.add('space'); return; }
    const step = e.shiftKey ? 160 : 40;
    if (e.key === 'ArrowLeft') { px += step; }
    else if (e.key === 'ArrowRight') { px -= step; }
    else if (e.key === 'ArrowUp') { py += step; }
    else if (e.key === 'ArrowDown') { py -= step; }
    else if (e.key === '+' || e.key === '=') { zoomBy(Z_STEP); return; }
    else if (e.key === '-') { zoomBy(-Z_STEP); return; }
    else if (e.key === '0') { fitView(); return; }
    else return;
    e.preventDefault();
    needFit.delete(famId);
    applyView();
  }

  // ---- the character picker ------------------------------------------------------------------------------------
  let dlg = null;
  function openPicker() {
    const f = family();
    if (!f || !S.data) return;
    if (!dlg) {
      dlg = el('dialog', 'fc-dialog');
      document.body.append(dlg);
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
      dlg.addEventListener('close', () => { (live && live.isConnected ? $('.fc-add', live) : null)?.focus(); });
    }
    const chosen = new Set();
    const pool = S.data.characters.filter((c) => !f.members.some((m) => m.id === c.id));
    const h = el('h2', 'fc-title', 'Add characters');
    const search = el('input', 'fc-search');
    search.type = 'search';
    search.placeholder = 'Search characters';
    search.spellcheck = false;
    search.setAttribute('aria-label', 'Search characters');
    const list = el('ul', 'fc-pick');
    list.setAttribute('aria-label', 'Characters not in this family');
    const msg = el('p', 'fc-none');
    msg.setAttribute('role', 'status');
    const foot = el('div', 'fc-foot');
    const cancel = btn('quiet-btn', '', 'Cancel');
    const ok = btn('primary', '', 'Add');
    ok.disabled = true;
    foot.append(cancel, ok);
    dlg.replaceChildren(h, search, list, msg, foot);

    const rows = pool.map((c) => {
      const li = el('li', 'fc-row');
      const lab = el('label', 'fc-rowlab');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => {
        if (cb.checked) chosen.add(c.id); else chosen.delete(c.id);
        ok.disabled = chosen.size === 0;
        ok.textContent = chosen.size > 1 ? `Add ${chosen.size}` : 'Add';
      });
      const pic = el('span', 'fc-pic');
      pic.setAttribute('aria-hidden', 'true');
      if (c.hasThumb) loadThumb(c.id).then((url) => { if (url && pic.isConnected) { const im = el('img'); im.alt = ''; im.src = url; pic.replaceChildren(im); } });
      else pic.append(icon('i-person-silhouette'));
      const txt = el('span', 'fc-txt');
      txt.append(el('span', 'fc-n', nameOf(c)));
      if (c.short) txt.append(el('span', 'fc-s', c.short));
      lab.append(cb, pic, txt);
      li.append(lab);
      li._hay = `${c.name || ''} ${(c.aliases || []).join(' ')} ${c.short || ''}`.toLowerCase();
      return li;
    });
    list.replaceChildren(...rows);
    const refilter = () => {
      const q = search.value.trim().toLowerCase();
      let n = 0;
      for (const li of rows) { const hit = !q || li._hay.includes(q); li.hidden = !hit; if (hit) n++; }
      msg.textContent = !pool.length ? 'Every character is already in this family.' : (n ? '' : 'No characters match.');
    };
    search.addEventListener('input', refilter);
    refilter();
    cancel.addEventListener('click', () => dlg.close());
    ok.addEventListener('click', () => {
      const cur = family();
      const ids = pool.map((c) => c.id).filter((id) => chosen.has(id));
      dlg.close();
      if (!cur || !ids.length) return;
      addMembers(cur, ids);
    });
    dlg.showModal();
    search.focus();
  }

  // New members go to the middle of the view in the first band, or one band below the selected node;
  // several are laid side by side so they do not stack.
  function addMembers(f, ids) {
    const anchor = selChar && f.members.find((m) => m.id === selChar);
    const base = anchor ? { x: anchor.x, gen: anchor.gen + 1 } : { x: viewCentre().x, gen: 0 };
    const gap = 96;
    const taken = (x, gen) => f.members.some((m) => m.gen === gen && Math.abs(m.x - x) < gap - 8);
    const items = [];
    let n = 0;
    for (const id of ids) {
      let x = snap(base.x + (n - (ids.length - 1) / 2) * gap);
      let guard = 0;
      while ((taken(x, base.gen) || items.some((i) => i.gen === base.gen && Math.abs(i.x - x) < gap - 8)) && guard++ < 60) x += gap;
      items.push({ id, x, gen: base.gen });
      n++;
    }
    S.addFamilyMembers(f.id, items);
    emw.toast(`Added ${items.length === 1 ? nameOf(charOf(items[0].id)) : items.length + ' characters'} to ${f.name || 'this family'}`, { action: { label: 'Undo', run: () => { S.undo(); } } });
    needFit.delete(famId);
    // Bring the new nodes into view if they landed off screen.
    const mx = items.map((i) => i.x * z + px);
    if (mx.some((v) => v < 0 || v > live.clientWidth)) fitView();
  }

  // ---- wiring ------------------------------------------------------------------------------------------------
  function show(id) {
    famId = id || '';
    selChar = '';
    thumbs.clear();   // a character's picture may have changed in the Characters tab since the last visit
    if (!famId || !family()) return;
    mount();
    const v = views.get(famId);
    if (v) { z = v.z; px = v.x; py = v.y; applyView(false); }
    else { z = 1; px = live.clientWidth / 2 || 400; py = 70; needFit.add(famId); applyView(false); if (live.clientWidth > 0) fitView(); }
    render();
  }

  ft.onSelect((id) => { if (id !== famId || !(live && live.isConnected)) show(id); });
  S.on(() => {
    if (!ft.active() || !famId) return;
    if (!family()) return;      // family-tree.js picks the next one and calls onSelect
    if (!(live && live.isConnected)) { show(famId); return; }
    render();
  });
  emw.book.onSwitch(() => { famId = ''; selChar = ''; views.clear(); needFit.clear(); thumbs.clear(); live = null; });

  emw.familyCanvas = { menuExtras, get layer() { return layer; }, fit: () => fitView(), addCharacters: openPicker };
  emw.actions.familyAddCharacter = () => { if (ft.active() && family()) openPicker(); };
  emw.keys.register({ id: 'familyAddCharacter', label: 'Add character to family tree', group: 'Navigate', when: () => ft.active() && !!family() && !document.querySelector('dialog[open]') });
})();
