// Family trees, canvas part 2 (part 7j2): relationship links drawn as coloured lines.
// The data is in the store (families[].links); this file turns each link into an SVG path inside the
// layer that family-canvas.js hands over (`emw.familyCanvas.layer`), lets the writer select, retype and
// remove them, offers the type picker when a connect drag lands, and keeps the legend and the nodes'
// accessible names in step with the store.
// Geometry: parent links use a classic elbow (parent's bottom -> shared bus -> down to each child) so
// children of one parent share the bus; spouse and sibling links run horizontally between the circles
// with a small per-pair offset so parallel lines do not overlap; anything else arcs, and every line
// bows away from a node that sits on top of it. All numbers come from S.FT_GEO, shared with the canvas
// and with 7j3's layout.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const ft = emw.familyTree;
  const fc = emw.familyCanvas;
  if (!ft || !fc) return;

  const G = S.FT_GEO;
  const R = G.R, BAND_H = G.BAND_H, GRID = G.GRID;
  const HIT_W = 10;                       // the invisible wider hit area
  const ELBOW_DY = 26;                    // below a parent's circle before the bus runs across
  const BUS_GAP = 14;                     // at least this far above the children's labels
  const ROW_STEP = 8;                     // offset per horizontal line crossing the same gap
  const ARC_LIFT = 0.18;                  // how much an unrelated link bows
  const DETOUR = 22;                      // clearance kept from other nodes
  const ARROW = 7;                        // arrowhead for directed types
  const LABEL_MAX = 30;                   // characters in a pill label before it is shortened

  const sv = (tag, attrs, cls) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (cls) n.setAttribute('class', cls);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    return n;
  };
  // SVG elements ignore the HTML dataset property, so every data-* on one of them goes through here.
  const sd = (node, key, value) => node.setAttribute('data-' + key, String(value));
  const gd = (node, key) => node.getAttribute('data-' + key);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const btn = (cls, label, text) => { const b = el('button', cls, text); b.type = 'button'; if (label) { b.setAttribute('aria-label', label); b.title = label; } return b; };
  const icon = (id) => { const s = sv('svg', { 'aria-hidden': 'true' }, 'ic'); s.append(sv('use', { href: '#' + id })); return s; };
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const announce = (msg) => { try { fc.announce?.(msg); } catch { /* ignore */ } };
  const charName = (id) => {
    const c = S.data && S.data.characters.find((x) => x.id === id);
    return (c && c.name) || 'Unnamed character';
  };

  // ---- state (view only; the data stays in the store) -------------------------------------------------
  let famId = '';
  let selLink = '';
  let focusType = '';          // the legend's "follow one kind" filter
  let legendOpen = false;      // remembered per book, like the panel states
  let host = null, rubber = null;
  const paths = new Map();     // link id -> { g, hit, line, lab, labW }
  const livePos = new Map();   // character id -> { id, x, y, gen }: where a node is mid-drag, before the store catches up

  const family = () => S.family(famId);
  // family-tree.js owns the blend. If it ever answers with something CSS cannot parse, fall back to a
  // plain token so the line still draws: an invalid custom property would blank every stroke at once.
  // (A built-in id is always one of the four --rel-* tokens; a custom type keeps its own colour.)
  const SAFE_COLOR = /^(var\(--[\w-]+\)|#[0-9a-f]{3,8}|color-mix|rgb[a]?|hsl[a])/i;
  const relColor = (t) => {
    let c = '';
    try { c = ft.relColor(t); } catch { c = ''; }
    if (!c || !SAFE_COLOR.test(c.trim())) c = t && t.builtin ? `var(--rel-${t.id})` : 'var(--rel-related)';
    return c;
  };
  const FALLBACK_TYPE = { id: S.REL_NEUTRAL, name: 'related', inverse: 'related', directed: false, builtin: true };
  const typeOf = (id) => S.relType(id) || S.relType(S.REL_NEUTRAL) || FALLBACK_TYPE;
  const keyOf = () => { try { return emw.book.key('familyLegend'); } catch { return 'emwriter.familyLegend'; } };

  // ---- geometry ------------------------------------------------------------------------------------------
  // A node's centre comes from the canvas element itself, or from the live drag position. The canvas
  // writes data-x and data-gen on every node; the y of a circle is always genY(gen), so lines and
  // nodes cannot drift apart even if one of them is redrawn without the other.
  function posOf(id) {
    if (livePos.has(id)) return livePos.get(id);
    const n = fc.nodes && fc.nodes.querySelector(`.fc-node[data-id="${id}"]`);
    if (n) {
      const gen = Number(n.getAttribute('data-gen')) || 0;
      return { id, x: Number(n.getAttribute('data-x')) || 0, y: S.genY(gen), gen };
    }
    const m = family() && family().members.find((x) => x.id === id);
    if (!m) return null;
    return { id, x: m.x, y: S.genY(m.gen), gen: m.gen };
  }
  const boxOf = (p) => ({ x0: p.x - R, x1: p.x + R, y0: p.y - R, y1: p.y + R + G.PILL_GAP + G.PILL_H });
  const midX = (a, b) => (Math.abs(a.x) < 1e-6 && Math.abs(b.x) < 1e-6 ? 0 : (a.x + b.x) / 2);
  // Path text stays short: two decimals at most, which is far below a pixel at any zoom.
  const fmt = (n) => String(Math.round(Number(n) * 100) / 100);

  // How far a horizontal run at height y must bow to keep clear of every node it crosses.
  function lift(y, x0, x1, skip) {
    let dy = 0;
    for (const [, p] of allPos()) {
      if (skip.includes(p.id)) continue;
      const b = boxOf(p);
      // Only a node that actually sits between the two ends can block the run.
      if (b.x1 < Math.min(x0, x1) + DETOUR || b.x0 > Math.max(x0, x1) - DETOUR) continue;
      if (y >= b.y0 - DETOUR && y <= b.y1 + DETOUR) dy = Math.max(dy, (y - b.y0) + DETOUR * 2);
    }
    return dy;
  }
  let posCache = null;
  function allPos() {
    if (posCache) return posCache;
    const out = [];
    for (const m of (family() ? family().members : [])) { const p = posOf(m.id); if (p) out.push([m.id, p]); }
    posCache = out;
    return out;
  }

  // Elbow points for one parent->child link, using the bus computed for that parent.
  function elbowPoints(from, to, bus) {
    const x0 = fmt(from.x), y0 = fmt(from.y + R);
    const x1 = fmt(to.x), y2 = fmt(to.y - R), my = fmt(bus);
    if (Math.abs(from.x - to.x) < 1) return `M${x0},${y0} L${x1},${y2}`;            // straight down
    const r = Math.min(8, Math.abs(to.x - from.x) / 2, Math.abs(bus - (from.y + R)));
    if (r >= 2) {
      const dir = to.x > from.x ? 1 : -1;
      return `M${x0},${y0} L${fmt(from.x)},${fmt(bus - r)} Q${x0},${my} ${fmt(from.x + dir * r)},${my} `
        + `L${fmt(to.x - dir * r)},${my} Q${x1},${my} ${x1},${fmt(bus + r)} L${x1},${y2}`;
    }
    return `M${x0},${y0} L${x0},${my} L${x1},${my} L${x1},${y2}`;
  }

  // Horizontal run between two circles at the same height, with a bow if something is in the way.
  function hRun(a, b, y) {
    const ax = fmt(a.x + R), bx = fmt(b.x - R);
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    const dy = lift(y, lo, hi, [a.id, b.id]);
    if (dy <= 2) return `M${ax},${fmt(y)} L${bx},${fmt(y)}`;
    return `M${ax},${fmt(y)} Q${fmt(midX(a, b))},${fmt(y - dy)} ${bx},${fmt(y)}`;
  }

  // Any other pair: a single arc, bowed away from a node that sits right on top of the middle.
  function arcRun(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    let nx = -dy / len, ny = dx / len;             // normal to the segment
    if (ny > 0) { nx = -nx; ny = -ny; }            // always bow upward: reads better among bands
    let off = len * ARC_LIFT;
    for (const [, p] of allPos()) {
      if (p.id === a.id || p.id === b.id) continue;
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < R * 2.4) off = Math.max(off, R * 2.4 - d + DETOUR);
    }
    const p0 = { x: a.x + (dx / len) * R, y: a.y + (dy / len) * R };
    const p2 = { x: b.x - (dx / len) * R, y: b.y - (dy / len) * R };
    const ctrl = { x: mx + nx * off, y: my + ny * off };
    return { d: `M${fmt(p0.x)},${fmt(p0.y)} Q${fmt(ctrl.x)},${fmt(ctrl.y)} ${fmt(p2.x)},${fmt(p2.y)}`, p0, p2, ctrl };
  }

  // Where a pill naming a link sits: the visual middle of its path.
  function pillAt(kind, a, b, bus, rows, arc) {
    if (kind === 'elbow') return { x: (a.x + b.x) / 2, y: bus + 11 };
    if (kind === 'h') return { x: (a.x + b.x) / 2, y: a.y + ROW_STEP * rows - 12 };
    if (kind === 'v') return { x: a.x, y: (a.y + b.y) / 2 };
    const t = 0.5, mt = 1 - t;                     // the point halfway along a quadratic curve
    return { x: mt * mt * arc.p0.x + 2 * mt * t * arc.ctrl.x + t * t * arc.p2.x,
             y: mt * mt * arc.p0.y + 2 * mt * t * arc.ctrl.y + t * t * arc.p2.y };
  }

  // ---- drawing one link ---------------------------------------------------------------------------------
  // `ctx` carries the buses and rows worked out for the whole set, plus how many links have already
  // been drawn over the same pair, so a second line stops short instead of sitting on the first.
  function buildLink(l, ctx) {
    const a = posOf(l.from), b = posOf(l.to);
    if (!a || !b) return null;
    const t = typeOf(l.type);
    const sameGen = a.gen === b.gen;
    const vertical = Math.abs(a.x - b.x) < 1;
    const key = S.linkKey(l.from, l.to);
    const seen = ctx.seen.get(key) || 0;
    ctx.seen.set(key, seen + 1);
    let kind = 'arc', bus = 0, rows = 0, arc = null, p0 = null, p2 = null;

    if ((l.type === 'parent' || t.directed) && !sameGen) {
      // Parent above child: the classic elbow on the parent's shared bus. The other way round, the same
      // shape upside down, because that child may have children of its own on the same bus.
      kind = 'elbow';
      const par = a.gen < b.gen ? a : b, kid = a.gen < b.gen ? b : a;
      bus = ctx.bus.get(par.id);
      if (bus === undefined) bus = par.y + R + ELBOW_DY;
    } else if (!t.directed && sameGen && !vertical) {
      // Spouse and sibling lines: horizontal between the circles, stepped so parallels do not overlap.
      kind = 'h';
      rows = ctx.rows.get(key) || 0;
    } else if (vertical && !sameGen) {
      kind = 'v';
    } else {
      kind = 'arc';
    }

    // A second line over a pair starts further out of the left-hand circle, so two spouse/sibling
    // links read as separate strokes rather than one thick one.
    const inset = seen * 7;
    let d = '';
    if (kind === 'elbow') {
      const par = a.gen < b.gen ? a : b, kid = a.gen < b.gen ? b : a;
      p0 = { x: par.x, y: par.y + R + inset }; p2 = { x: kid.x, y: kid.y - R };
      d = elbowPoints({ ...par, y: par.y + inset }, kid, bus);
    } else if (kind === 'h') {
      p0 = { x: a.x + R + inset, y: a.y }; p2 = { x: b.x - R, y: b.y };
      d = hRun({ ...a, x: a.x - inset }, b, a.y + ROW_STEP * rows - 4);
    } else if (kind === 'v') {
      const up = a.gen < b.gen;
      p0 = { x: a.x, y: up ? a.y + R + inset : a.y - R - inset };
      p2 = { x: b.x, y: up ? b.y - R : b.y + R };
      d = `M${fmt(p0.x)},${fmt(p0.y)} L${fmt(p2.x)},${fmt(p2.y)}`;
    } else {
      arc = arcRun({ ...a, x: a.x - inset }, b);
      d = arc.d; p0 = arc.p0; p2 = arc.p2;
    }

    const g = sv('g', { role: 'presentation' }, 'fc-link');
    sd(g, 'link', l.id);
    sd(g, 'type', l.type);
    const hit = sv('path', { d, fill: 'none', 'stroke-width': HIT_W }, 'fc-hit');
    hit.setAttribute('aria-hidden', 'true');
    const line = sv('path', { d, fill: 'none' }, 'fc-line');
    line.style.setProperty('--rc', relColor(t));
    g.append(hit, line);

    // An arrowhead marks a directed type; the pair itself stays undirected in the store.
    if (t.directed) {
      const tip = arrowTip(d, p0, p2, kind, bus);
      if (tip) {
        const tri = sv('polygon', { points: `${fmt(tip.x)},${fmt(tip.y)} ${fmt(tip.x - tip.nx * ARROW - tip.tx * ARROW * 1.4)},${fmt(tip.y - tip.ny * ARROW - tip.ty * ARROW * 1.4)} ${fmt(tip.x - tip.nx * ARROW + tip.tx * ARROW * 1.4)},${fmt(tip.y - tip.ny * ARROW + tip.ty * ARROW * 1.4)}` }, 'fc-arrow');
        tri.style.setProperty('--rc', relColor(t));
        tri.setAttribute('aria-hidden', 'true');
        g.append(tri);
      }
    }

    const label = cap(t.name).length > LABEL_MAX ? cap(t.name).slice(0, LABEL_MAX - 1) + '…' : cap(t.name);
    const lab = sv('g', {}, 'fc-lab');
    lab.setAttribute('aria-hidden', 'true');
    const w = Math.max(46, Math.min(G.PILL_W, label.length * 6.6 + 16));
    const at = pillAt(kind, a, b, bus, rows, arc || { p0, p2, ctrl: { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 } });
    const rect = sv('rect', { x: fmt(-w / 2), y: fmt(-G.PILL_H / 2), width: fmt(w), height: fmt(G.PILL_H), rx: fmt(G.PILL_H / 2) }, 'fc-lab-pill');
    const text = sv('text', { x: 0, y: 4, 'text-anchor': 'middle' }, 'fc-lab-text');
    text.textContent = label;
    lab.append(rect, text);
    lab.setAttribute('transform', `translate(${fmt(at.x)} ${fmt(at.y)})`);
    g.append(lab);

    // Keyboard access and the accessible name.
    hit.setAttribute('tabindex', '0');
    hit.setAttribute('role', 'button');
    hit.setAttribute('aria-label', `${cap(t.name)}: ${charName(l.from)} to ${charName(l.to)}`);
    sd(hit, 'link', l.id);
    if (selLink === l.id) { g.classList.add('selected'); hit.setAttribute('aria-pressed', 'true'); }
    bindHit(hit, l.id);
    return { g, hit, line, lab, labW: w };
  }

  // The last point of a path, with the direction it arrives from (for the arrowhead).
  function arrowTip(d, p0, p2, kind, bus) {
    const nums = d.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    const x = Number(nums[nums.length - 2]), y = Number(nums[nums.length - 1]);
    let tx, ty;
    if (kind === 'elbow') { tx = 0; ty = y > bus ? 1 : -1; }
    else if (kind === 'h') { tx = p2.x >= p0.x ? 1 : -1; ty = 0; }
    else if (kind === 'v') { tx = 0; ty = p2.y >= p0.y ? 1 : -1; }
    else { const len = Math.hypot(p2.x - p0.x, p2.y - p0.y) || 1; tx = (p2.x - p0.x) / len; ty = (p2.y - p0.y) / len; }
    return { x, y, tx, ty, nx: -ty, ny: tx };
  }

  // ---- the whole set ---------------------------------------------------------------------------------------
  function renderLinks() {
    posCache = null;
    const f = family();
    const layer = fc.layer;
    if (!layer) { posCache = null; return; }
    paths.clear();
    if (!f) { layer.replaceChildren(); posCache = null; return; }

    // Shared buses: one per parent, kept clear of the labels of its children. Two parents whose
    // children sit in the same band get buses BUS_GAP apart, so their elbows never merge.
    const bus = new Map();
    const taken = [];
    for (const m of f.members) {
      const kids = f.links
        .filter((l) => l.type === 'parent' && l.from === m.id)
        .map((l) => posOf(l.to)).filter(Boolean).filter((p) => p.gen > m.gen);
      if (!kids.length) continue;
      const py = posOf(m.id);
      if (!py) continue;
      const low = Math.max(...kids.map((k) => k.y));
      const want = low - R - G.PILL_GAP - G.PILL_H - 4;          // just above the tallest label
      const min = py.y + R + ELBOW_DY;
      let v = Math.max(min, Math.min(want, (min + want) / 2));
      for (const t of taken) if (Math.abs(t - v) < BUS_GAP) v = t + BUS_GAP;
      taken.push(v);
      bus.set(m.id, v);
    }
    // Parallel horizontal links on one pair get their own row.
    const rows = new Map();
    let nextRow = 1;
    for (const l of f.links) {
      const t = typeOf(l.type);
      const a = posOf(l.from), b = posOf(l.to);
      if (!a || !b || t.directed || a.gen !== b.gen || Math.abs(a.x - b.x) < 1) continue;
      const k = S.linkKey(l.from, l.to);
      if (!rows.has(k)) rows.set(k, nextRow++);
    }
    const ctx = { bus, rows, seen: new Map() };

    const frag = document.createDocumentFragment();
    for (const l of f.links) {
      try {
        const built = buildLink(l, ctx);
        if (built) { frag.append(built.g); paths.set(l.id, built); }
      } catch { /* one bad line must not lose the rest */ }
    }
    layer.replaceChildren(frag);
    applyFocus();
    posCache = null;
  }

  function applyFocus() {
    const layer = fc.layer;
    if (!layer) return;
    if (focusType) layer.setAttribute('data-focus', focusType);
    else layer.removeAttribute('data-focus');
    for (const [, o] of paths) o.g.classList.toggle('dimmed', !!focusType && o.g.getAttribute('data-type') !== focusType);
    if (host) host.classList.toggle('has-focus', !!focusType);
  }

  // A kind that vanishes (its last link removed, or its type deleted) must not leave the canvas dimmed
  // with nothing lit. Called after every redraw, before the legend paints its buttons.
  function validateFocus(silent) {
    if (!focusType) return;
    const f = family();
    const still = !!(f && f.links.some((l) => l.type === focusType));
    if (still) return;
    const had = focusType;
    focusType = '';
    applyFocus();
    renderLegend();
    if (!silent) announce(`No ${cap(typeOf(had).name)} links left, so every kind is shown again.`);
  }

  // Called on every pointermove of a node drag. Rebuilding the whole set is cheap for a tree (a few
  // dozen lines) and keeps the paths, the buses and the labels honest instead of approximating them.
  function refreshLive() { renderLinks(); }

  // ---- node labels that name the relations --------------------------------------------------------------------
  function relText(id) {
    const f = family();
    if (!f) return '';
    const parts = [];
    const add = (label, other) => {
      const i = parts.findIndex((p) => p.label === label);
      if (i < 0) parts.push({ label, names: [other] });
      else if (parts[i].names.length < 6) parts[i].names.push(other);
      else if (parts[i].names.length === 6) parts[i].names.push('…');
    };
    for (const l of f.links) {
      const t = typeOf(l.type);
      if (l.from === id) add(cap(t.name), charName(l.to));
      else if (l.to === id) add(cap(t.inverse && t.inverse !== t.name ? t.inverse : t.name), charName(l.from));
      else continue;
    }
    if (!parts.length) return '';
    return parts.map((p) => `${p.label}: ${p.names.join(', ')}`).join('; ');
  }

  function updateNodeLabels() {
    const f = family();
    if (!f) return;
    for (const m of f.members) {
      const base = charName(m.id);
      const rel = relText(m.id);
      try { fc.setNodeLabel?.(m.id, rel ? `${base}. Relationships: ${rel}.` : base); } catch { /* ignore */ }
    }
  }

  // ---- the legend -----------------------------------------------------------------------------------------------
  // The toggle and the list live in the slot family-canvas.js put aside for them, so they share the
  // stage's stacking order with the zoom bar and never sit under the lines.
  function buildHost() {
    if (host && host.isConnected) return;
    const slot = fc.legendSlot || fc.liveEl;
    if (!slot) return;                       // the canvas is not mounted yet; redraw will try again
    host = el('div', 'fc-legend-wrap');
    const toggle = btn('fc-legend-toggle', '', '');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.append(icon('i-link'), el('span', 'fc-legend-name', 'Relationships'), el('span', 'fc-legend-count'), icon('i-chev'));
    // The count only repeats what the list says; the accessible name carries it instead.
    toggle.querySelector('.fc-legend-count').setAttribute('aria-hidden', 'true');
    const list = el('ul', 'fc-legend');
    list.hidden = true;
    toggle.addEventListener('click', () => setLegend(!legendOpen));
    host.append(toggle, list);
    slot.append(host);
  }

  function setLegend(open) {
    legendOpen = open;
    try { localStorage.setItem(keyOf(), open ? '1' : ''); } catch { /* view state only */ }
    if (host) {
      const t = host.querySelector('.fc-legend-toggle');
      const list = host.querySelector('.fc-legend');
      if (t) t.setAttribute('aria-expanded', String(open));
      if (list) list.hidden = !open;
      host.classList.toggle('open', open);
    }
    if (open) renderLegend();
  }

  function renderLegend() {
    if (!host) return;
    const list = host.querySelector('.fc-legend');
    const count = host.querySelector('.fc-legend-count');
    const toggle = host.querySelector('.fc-legend-toggle');
    if (!list) return;
    const used = usedTypes();
    if (count) count.textContent = used.length ? String(used.length) : '';
    if (toggle) toggle.setAttribute('aria-label', used.length ? `Relationships: ${used.length} kind${used.length > 1 ? 's' : ''}` : 'Relationships');
    list.replaceChildren(...used.map((u) => {
      const li = el('li', 'fc-leg-item');
      const b = btn('fc-leg-btn');
      b.dataset.type = u.t.id;
      b.setAttribute('aria-pressed', String(focusType === u.t.id));
      b.setAttribute('aria-label', `${cap(u.t.name)}: ${u.n} link${u.n > 1 ? 's' : ''}. Show only this kind.`);
      const dot = el('i', 'fc-leg-dot');
      dot.setAttribute('aria-hidden', 'true');
      dot.style.setProperty('--rc', relColor(u.t));
      b.append(dot, el('span', 'fc-leg-name', cap(u.t.name)), el('span', 'fc-leg-n', String(u.n)));
      b.addEventListener('click', () => setFocus(focusType === u.t.id ? '' : u.t.id));
      li.append(b);
      return li;
    }));
    if (!used.length) list.append(el('li', 'fc-leg-none', 'No relationships yet. Drag from a character’s handle onto another to add one.'));
  }

  // Types present in this tree, in the order the manager lists them.
  function usedTypes() {
    const f = family();
    if (!f) return [];
    const out = [];
    for (const t of (S.data.relationTypes || [])) {
      const n = f.links.filter((l) => l.type === t.id).length;
      if (n) out.push({ t, n });
    }
    return out;
  }

  function setFocus(typeId) {
    focusType = typeId || '';
    applyFocus();
    renderLegend();
    // The kind being filtered may not exist in this tree at all (a menu can be opened on any type).
    if (focusType) {
      const f = family();
      if (!f || !f.links.some((l) => l.type === focusType)) { focusType = ''; applyFocus(); renderLegend(); }
    }
    announce(focusType ? `Showing only ${cap(typeOf(focusType).name)} links.` : 'Showing every kind of link.');
  }

  // ---- the type picker -------------------------------------------------------------------------------------------
  // Reads in direction: from the end the writer started at, toward the other one.
  function typeItems(fromId, toId, onPick) {
    const items = [];
    for (const t of S.data.relationTypes || []) {
      const word = t.directed ? t.name : (t.inverse && t.inverse !== t.name && fromId > toId ? t.inverse : t.name);
      const a = charName(fromId), b = charName(toId);
      items.push({
        dot: relColor(t),
        label: `${a} is ${word} of ${b}`,
        run: () => onPick(t.id)
      });
    }
    items.push(null);
    items.push({ label: 'New relationship…', run: () => ft.openRelationships() });
    return items;
  }

  function connectDrop(fromId, toId) {
    const f = family();
    if (!f || !fromId || !toId || fromId === toId) return;
    if (!f.members.some((m) => m.id === fromId) || !f.members.some((m) => m.id === toId)) return;
    const r = fc.nodes && fc.nodes.querySelector(`.fc-node[data-id="${toId}"]`);
    const box = r ? r.getBoundingClientRect() : { left: innerWidth / 2, bottom: innerHeight / 2, width: 0 };
    emw.menu(box.left + box.width / 2 - 110, box.bottom + 4, typeItems(fromId, toId, (typeId) => createLink(f.id, fromId, toId, typeId)));
  }

  function createLink(fid, fromId, toId, typeId) {
    const id = S.addFamilyLink(fid, fromId, toId, typeId);
    if (!id) {
      announce('Those two are already linked that way.');
      emw.toast('Those two characters already have that relationship');
      return;
    }
    const t = typeOf(typeId);
    announce(`${charName(fromId)} is now ${t.name} of ${charName(toId)}.`);
  }

  // ---- line interaction ---------------------------------------------------------------------------------------------
  function bindHit(hit, linkId) {
    hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    hit.addEventListener('click', (e) => { e.stopPropagation(); select(linkId); });
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(linkId); openLineMenu(linkId, e.clientX || 0, e.clientY || 0); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeLink(linkId); }
      else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); const r = hit.getBoundingClientRect(); openLineMenu(linkId, r.left + r.width / 2, r.bottom); }
    });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      select(linkId);
      openLineMenu(linkId, e.clientX, e.clientY);
    });
    hit.addEventListener('focus', () => showPill(linkId, true));
    hit.addEventListener('blur', () => showPill(linkId, false));
    hit.addEventListener('pointerenter', () => showPill(linkId, true));
    hit.addEventListener('pointerleave', () => showPill(linkId, false));
  }

  // The hover/focus pill is the plain label made solid and raised; CSS does the work.
  function showPill(linkId, on) {
    const o = paths.get(linkId);
    if (o) o.g.classList.toggle('showing', !!on);
  }

  function select(linkId) {
    selLink = linkId || '';
    for (const [id, o] of paths) {
      const on = id === selLink;
      o.g.classList.toggle('selected', on);
      o.hit.setAttribute('aria-pressed', String(on));
    }
  }

  function openLineMenu(linkId, x, y) {
    const f = family();
    const l = f && S.findLink(f.id, linkId);
    if (!l) return;
    const items = [{ label: 'Change type', run: () => pickType(linkId) }];
    if ((S.data.relationTypes || []).length > 1) {
      items.unshift({ label: `Reads: ${charName(l.from)} is ${typeOf(l.type).name} of ${charName(l.to)}`, disabled: true });
    }
    items.push(null, { label: 'Remove relationship', danger: true, run: () => removeLink(linkId) });
    emw.menu(x, y, items);
  }

  function pickType(linkId) {
    const f = family();
    const l = f && S.findLink(f.id, linkId);
    if (!l) return;
    const o = paths.get(linkId);
    const box = (o && o.g.getBoundingClientRect()) || { left: innerWidth / 2, top: innerHeight / 2, width: 0, bottom: 0 };
    const items = [];
    for (const t of S.data.relationTypes || []) {
      items.push({
        dot: relColor(t),
        label: cap(t.name) + (l.type === t.id ? ' (current)' : ''),
        checked: l.type === t.id,
        run: () => { S.updateFamilyLink(f.id, linkId, { type: t.id }); announce(`Relationship is now ${cap(t.name)}.`); }
      });
    }
    items.push(null, { label: 'New relationship…', run: () => ft.openRelationships() });
    emw.menu(box.left, box.bottom + 2, items);
  }

  function removeLink(linkId) {
    const f = family();
    const l = f && S.findLink(f.id, linkId);
    if (!f || !l) return;
    const t = typeOf(l.type);
    const text = `Removed ${cap(t.name)} between ${charName(l.from)} and ${charName(l.to)}`;
    if (selLink === linkId) selLink = '';
    S.removeFamilyLink(f.id, linkId);
    // Destructive, immediate, undoable from the toast (store undo covers links).
    emw.toast(text, { action: { label: 'Undo', run: () => { S.undo(); } } });
    announce(text);
  }

  // ---- the rubber band ---------------------------------------------------------------------------------------
  function ensureRubber() {
    if (rubber && rubber.isConnected) return rubber;
    const stage = document.querySelector('.ft-canvas-live');
    if (!stage) return null;
    const svg = sv('svg', { 'aria-hidden': 'true' }, 'fc-rubber');
    rubber = sv('line', { x1: 0, y1: 0, x2: 0, y2: 0 }, 'fc-rubber-line');
    svg.append(rubber);
    stage.append(svg);
    return svg;
  }

  function showRubber(x0, y0, x1, y1) {
    const svg = ensureRubber();
    if (!svg) return;
    svg.setAttribute('width', String(Math.max(1, svg.parentNode.clientWidth || 1)));
    svg.setAttribute('height', String(Math.max(1, svg.parentNode.clientHeight || 1)));
    const r = svg.getBoundingClientRect();
    rubber.setAttribute('x1', fmt(x0 - r.left));
    rubber.setAttribute('y1', fmt(y0 - r.top));
    rubber.setAttribute('x2', fmt(x1 - r.left));
    rubber.setAttribute('y2', fmt(y1 - r.top));
    svg.hidden = false;
  }

  function hideRubber() { if (rubber && rubber.parentNode) rubber.parentNode.hidden = true; }

  // ---- keeping up -----------------------------------------------------------------------------------------------
  function redraw() {
    const f = family();
    famId = (f && f.id) || '';
    renderLinks();
    updateNodeLabels();
    buildHost();
    renderLegend();
    validateFocus(true);   // a filter whose kind disappeared is lifted without chatter
  }

  // Called while a node is being dragged: remember where it is, then move the labels.
  function redrawLive() {
    const n = fc.nodes && fc.nodes.querySelector('.fc-node.dragging');
    const id = n && n.getAttribute('data-id');
    if (id) {
      const m = n.getAttribute('transform').match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/);
      if (m) livePos.set(id, { id, x: Number(m[1]), y: Number(m[2]), gen: Number(n.getAttribute('data-gen')) || 0 });
    }
    refreshLive();
  }

  function init() {
    const stage = document.querySelector('.ft-canvas-live');
    if (!stage) return;
    stage.addEventListener('dragend', () => livePos.clear());
    // Escape anywhere on the stage stops a connect that is in progress.
    stage.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fc.connecting && fc.connecting()) { e.preventDefault(); fc.cancelConnect(); } });
  }

  // A menu or dialog opening must not leave a half-finished connect behind.
  document.addEventListener('mousedown', () => { if (fc.connecting && fc.connecting() && fc.cancelConnect) fc.cancelConnect(); }, true);

  ft.onSelect(() => { selLink = ''; livePos.clear(); hideRubber(); redraw(); });
  S.on(() => { if (ft.active()) redraw(); });
  emw.book.onSwitch(() => { famId = ''; selLink = ''; focusType = ''; paths.clear(); livePos.clear(); });
  queueMicrotask(() => {
    try { legendOpen = localStorage.getItem(keyOf()) === '1'; } catch { legendOpen = false; }
    init();
    buildHost();
    if (legendOpen) setLegend(true);
  });

  // Menu extras: the ≡ button on the canvas.
  if (fc.menuExtras) fc.menuExtras.push(() => [
    { label: 'Relationships…', run: () => ft.openRelationships() },
    { label: 'Add character…', run: () => fc.addCharacters && fc.addCharacters() }
  ]);

  emw.familyLinks = {
    redraw, redrawLive, connectDrop, showRubber, hideRubber,
    selected: () => selLink, focusType: () => focusType, setFocus, removeLink, openLineMenu
  };
  emw.actions.familyRelationships = () => { if (ft.active()) ft.openRelationships(); };
  emw.keys.register({ id: 'familyRelationships', label: 'Relationship types', group: 'Navigate', when: () => ft.active() && !document.querySelector('dialog[open]') });
})();
