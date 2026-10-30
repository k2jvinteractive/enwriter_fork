// Darlings: things the writer wants out of the way but not deleted.
// The data and the undoable send/restore live in the store; this file is everything around it:
// sending (menus, drag to the tab, Ctrl+Shift+D, the editor's right-click menu), restoring text
// into scenes, the Darlings tab, the per-tab counts and the inspector's Darlings panel.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const emw = window.emw;
  const S = emw.store;
  const editorEl = $('#editor');

  const ORIGIN_LABEL = { manuscript: 'Manuscript', timeline: 'Timeline', characters: 'Characters', places: 'Places', notes: 'Notes', tags: 'Tags' };
  const KIND_LABEL = { text: 'Text', scene: 'Scene', chapter: 'Chapter', plotline: 'Plotline', character: 'Character', place: 'Place', note: 'Note', tag: 'Tag', category: 'Category', family: 'Family' };
  const BLOCKY = /<(p|h[1-6]|blockquote|ul|ol|li|hr)[\s>/]/i;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const sceneName = (s) => s.title.trim() || 'Untitled scene';
  const failSafe = (fn) => { try { return fn(); } catch { return undefined; } };

  // ---- going places -------------------------------------------------------------------
  let filter = '';
  let query = '';
  let sel = '';          // the darling shown in the preview pane (view state, not data)
  let mode = 'all';      // part 7e: 'all' | 'darlings' (removed items) | 'snapshots'

  function openDarlings(origin = '', selectId = '') {
    filter = origin;
    if (selectId) sel = selectId;
    if (mode === 'snapshots') setMode('all');   // asked for a darling: show it
    emw.showView('darlings');
    render();
  }

  // Part 7e: the Darlings tab also holds the project's snapshots (snapshots.js draws their cards and preview).
  const modesEl = $('#dl-modes');
  function setMode(m) {
    mode = m;
    for (const b of modesEl.children) b.setAttribute('aria-selected', String(b.dataset.mode === m));
  }
  function openMode(m, snapshotId = '') {
    filter = '';
    query = '';
    $('#dl-search').value = '';
    setMode(m);
    if (snapshotId && emw.snapshots) emw.snapshots.select(snapshotId);
    emw.showView('darlings');
    render();
  }

  function show(target) {
    if (!target) return;
    if (target.kind === 'scene' || target.kind === 'chapter') emw.actions.openScene(target.id);   // openDoc handles both
    else if (target.kind === 'plotline') emw.showView('timeline');
    else if (target.kind === 'category') emw.showView(target.entityKind);
    else if (target.kind === 'family') emw.familyTree.open(target.id);
    else emw.openEntity(S.ENTITY_KIND[target.kind], target.id);
  }

  // ---- sending ------------------------------------------------------------------------
  const quote = (s) => `“${clip(s, 40)}”`;

  // Items that point at files (scenes, notes, thumbnails) keep them where they are, so sending
  // only has to be sure the latest text is on disk.
  async function settleFiles() {
    try { await emw.actions.flush?.(); } catch { /* ignore */ }
    for (const f of emw.flushHooks) failSafe(f);
  }

  async function send(kind, id, opts = {}) {
    if (kind === 'chapter' && S.data.chapters.length <= 1) { emw.toast('A novel needs at least one chapter'); return null; }
    if (kind === 'plotline' && S.data.plotlines.length <= 1) { emw.toast('Keep at least one plotline'); return null; }
    await settleFiles();
    const did = S.sendToDarlings(kind, id, opts);
    if (!did) { emw.toast('That could not be sent to Darlings'); return null; }
    const rec = S.findDarling(did);
    emw.toast(`Sent ${quote(rec.label)} to Darlings`, {
      actions: [{ label: 'Undo', run: () => { S.undo(); } }, { label: 'Open darlings', run: () => openDarlings() }]
    });
    return did;
  }

  // ---- text: what is in the editor ---------------------------------------------------------
  const sceneId = () => { const d = emw.curDoc?.(); return d && d.kind === 'scene' ? d.item.id : null; };

  // The top-level block of `root` that holds `node`, or null.
  function topBlock(root, node) {
    let n = node && (node.nodeType === 1 ? node : node.parentElement);
    while (n && n !== root && n.parentElement !== root) n = n.parentElement;
    return !n || n === root ? null : n;
  }
  // Plain-text position of a point, counting text only: the same measure on live and parsed HTML.
  const offsetIn = (root, node, off) => {
    const r = document.createRange();
    r.setStart(root, 0);
    r.setEnd(node, off);
    return r.toString().length;
  };

  function capture(range, block) {
    const text = range.toString();
    const holder = el('div');
    holder.append(range.cloneContents());
    if (!text.trim() && !holder.querySelector('img,hr')) return null;
    const offset = offsetIn(editorEl, range.startContainer, range.startOffset);
    return {
      html: block ? block.outerHTML : holder.innerHTML,
      preview: text.replace(/\s+/g, ' ').trim(),
      offset,
      anchor: editorEl.textContent.slice(Math.max(0, offset - 40), offset),
      block: !!block
    };
  }

  // Order: the darling's file is written first, then the store learns about it, then the text
  // leaves the editor with execCommand so Ctrl+Z in the editor also works. If anything fails
  // before the last step, the text is still in the scene.
  async function sendText(cap, { range, remove = true } = {}) {
    const sid = sceneId();
    if (!sid) { emw.toast('Open a scene first'); return null; }
    const id = S.uid();
    try { await emw.files.write('darling-' + id, cap.html); } catch { emw.toast('Could not save that text, so nothing was removed'); return null; }
    const did = S.sendToDarlings('text', sid, { id, origin: 'manuscript', preview: cap.preview, offset: cap.offset, anchor: cap.anchor, block: cap.block });
    if (!did) { emw.toast('That could not be sent to Darlings'); return null; }
    if (remove && range) {
      editorEl.focus();
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.execCommand('delete');
    }
    emw.toast(`Sent ${quote(cap.preview)} to Darlings`, {
      // Undo puts the text back through the same restore path, so it works even after the scene was closed.
      actions: [{ label: 'Undo', run: () => restoreText(S.findDarling(did)) }, { label: 'Open darlings', run: () => openDarlings() }]
    });
    return did;
  }

  function sendSelection(saved) {
    const s = getSelection();
    const range = saved || (s.rangeCount && !s.isCollapsed && editorEl.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null);
    if (!range || range.collapsed) { emw.toast('Select some text first'); return null; }
    const cap = capture(range, null);
    if (!cap) { emw.toast('Select some text first'); return null; }
    return sendText(cap, { range });
  }

  function sendParagraph(saved) {
    const s = getSelection();
    const anchor = saved ? saved.startContainer : (s.rangeCount ? s.anchorNode : null);
    const block = anchor && editorEl.contains(anchor) ? topBlock(editorEl, anchor) : null;
    if (!block || !block.textContent.trim()) { emw.toast('There is no text in this paragraph'); return null; }
    const range = document.createRange();
    range.selectNodeContents(block);
    const cap = capture(range, block);
    return cap ? sendText(cap, { range }) : null;
  }

  // ---- text: putting it back ---------------------------------------------------------------
  // Where it goes: the stored offset if the 40 characters before it still match; else wherever
  // those characters now are; else the end of the scene.
  function plan(root, rec) {
    const text = root.textContent;
    const { offset, anchor } = rec.restore;
    if (offset <= text.length && text.slice(Math.max(0, offset - anchor.length), offset) === anchor) return { at: offset, how: 'exact' };
    const i = anchor ? text.indexOf(anchor) : -1;
    if (i >= 0) return { at: i + anchor.length, how: 'anchor' };
    return { at: text.length, how: 'end' };
  }

  // The text position as a DOM point. At a block boundary this picks the end of the earlier block.
  function pointAt(root, at) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let last = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      last = n;
      if (at <= acc + n.length) return { node: n, offset: at - acc };
      acc += n.length;
    }
    return last ? { node: last, offset: last.length } : { node: root, offset: 0 };
  }

  const textBefore = (block, pt) => {
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(pt.node, pt.offset);
    return r.toString();
  };
  const isBlocky = (clean, rec) => rec.restore.block || BLOCKY.test(clean);

  // Scene is open in the visible editor: insert with execCommand so it joins the editor's undo
  // history and the normal autosave runs.
  function insertIntoEditor(clean, rec) {
    const p = plan(editorEl, rec);
    const pt = pointAt(editorEl, p.at);
    const r = document.createRange();
    if (pt.node === editorEl) {
      r.selectNodeContents(editorEl.firstElementChild || editorEl);
      r.collapse(true);
    } else if (isBlocky(clean, rec) && topBlock(editorEl, pt.node)) {
      const b = topBlock(editorEl, pt.node);
      r.selectNodeContents(b);
      r.collapse(textBefore(b, pt) === '');   // start of a block: before it; anywhere else: after it
    } else {
      r.setStart(pt.node, pt.offset);
      r.collapse(true);
    }
    editorEl.focus();
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('styleWithCSS', false, false);
    return document.execCommand('insertHTML', false, clean) ? p.how : null;
  }

  // Scene is not on screen: change its stored HTML. The inserted piece is sanitised; the rest of
  // the scene is left exactly as it was, so its formatting survives.
  function insertIntoDom(root, clean, rec, p) {
    const doc = root.ownerDocument;
    const frag = doc.createDocumentFragment();
    for (const n of [...new DOMParser().parseFromString(clean, 'text/html').body.childNodes]) frag.append(doc.importNode(n, true));
    const pt = pointAt(root, p.at);
    if (pt.node === root) {   // a scene with no text yet
      if (isBlocky(clean, rec)) root.replaceChildren(frag);
      else { const para = doc.createElement('p'); para.append(frag); root.replaceChildren(para); }
      return;
    }
    if (isBlocky(clean, rec)) {
      const b = topBlock(root, pt.node);
      if (!b) root.append(frag);
      else if (textBefore(b, pt) === '') b.before(frag);
      else b.after(frag);
      return;
    }
    const r = doc.createRange();
    r.setStart(pt.node, pt.offset);
    r.collapse(true);
    r.insertNode(frag);
  }

  function plainWords(root) {
    const copy = root.cloneNode(true);
    copy.querySelectorAll('p,h1,h2,h3,h4,li,blockquote,div,br,hr').forEach((n) => n.after(' '));
    return (copy.textContent.match(/\S+/g) || []).length;
  }

  async function insertIntoFile(clean, rec, loaded) {
    const sid = rec.restore.sceneId;
    try {
      await emw.actions.flush?.();   // anything typed but not yet written goes first
      const doc = new DOMParser().parseFromString((await emw.files.read(sid)) || '', 'text/html');
      const p = plan(doc.body, rec);
      insertIntoDom(doc.body, clean, rec, p);
      const out = doc.body.innerHTML;
      await emw.files.write(sid, out);                // files first, then the store
      S.setWords(sid, plainWords(doc.body));
      if (loaded) emw.editor.load(out);               // the editor still holds the old text; show the new
      return p.how;
    } catch {
      return null;
    }
  }

  async function restoreText(rec) {
    if (!rec) return null;
    const r = rec.restore;
    const f = S.find.scene(r.sceneId);
    if (!f) {
      emw.toast('The original scene no longer exists', { actions: [{ label: 'Open darlings', run: () => openDarlings('', rec.id) }] });
      return null;
    }
    let raw = '';
    try { raw = await emw.files.read('darling-' + rec.id); } catch { /* handled below */ }
    const clean = raw && raw.trim() ? emw.sanitize(raw) : '';
    if (!clean) { emw.toast('That text could not be read, so it stays in Darlings'); return null; }

    const cur = emw.curDoc?.();
    const loaded = !!cur && cur.kind === 'scene' && cur.item.id === r.sceneId;
    const how = loaded && emw.view() === 'manuscript' ? insertIntoEditor(clean, rec) : await insertIntoFile(clean, rec, loaded);
    if (!how) { emw.toast('Could not put that text back, so it stays in Darlings'); return null; }

    // Only now does it leave the list. The darling-<id> file stays on disk as a backup.
    S.discardDarling(rec.id);
    const where = `“${sceneName(f.scene)}”`;
    const msg = how === 'exact' ? `Text restored to ${where}`
      : how === 'anchor' ? `Text restored to ${where}, near where it was cut`
        : `The original spot has changed, so the text was added to the end of ${where}`;
    emw.toast(msg, { actions: [{ label: 'Show', run: () => emw.actions.openScene(r.sceneId) }] });
    return how;
  }

  // ---- restore and delete (any kind) ------------------------------------------------------------
  async function restore(id) {
    const rec = S.findDarling(id);
    if (!rec) return;
    if (rec.kind === 'text') { await restoreText(rec); return; }
    const res = S.restoreDarling(id);
    if (!res || res.error) { emw.toast((res && res.error) || 'That could not be restored'); return; }
    emw.toast(res.notice || `Restored ${quote(rec.label)}`, { actions: [{ label: 'Show', run: () => show(res.show) }] });
  }

  function remove(id) {
    const rec = S.deleteDarling(id);
    if (!rec) return;
    emw.toast(`Deleted ${quote(rec.label)} from Darlings`, {
      action: { label: 'Undo', run: () => { if (rec.kind === 'text') S.readdDarling(rec); else S.undo(); } }
    });
  }

  emw.darlings = { send, sendSelection, sendParagraph, restore, remove, open: openDarlings, openMode, render: () => schedule(), deselect: () => { sel = ''; } };

  // ---- the editor's right-click menu ---------------------------------------------------------------
  editorEl.addEventListener('contextmenu', (e) => {
    if (!sceneId()) return;
    // No preventDefault and no menu of our own: Chromium reports the right-click to the main process,
    // spellcheck.js builds one menu (corrections, Cut, Copy, Paste, Select all) and appends these items.
    const s = getSelection();
    let range = s.rangeCount ? s.getRangeAt(0) : null;
    const hit = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    const inside = range && !range.collapsed && hit && range.isPointInRange(hit.startContainer, hit.startOffset);
    // Right-clicking away from the selection moves the caret there, as in any editor.
    if (!inside && hit && editorEl.contains(hit.startContainer)) { range = hit; s.removeAllRanges(); s.addRange(hit); }
    if (!range || !editorEl.contains(range.startContainer)) return;
    const saved = range.cloneRange();
    const has = !saved.collapsed && !!saved.toString().trim();
    const item = has
      ? { label: 'Send selection to Darlings', run: () => sendSelection(saved) }
      : { label: 'Send paragraph to Darlings', run: () => sendParagraph(saved) };
    if (emw.spell) emw.spell.setExtra([item]);
    else emw.menu(e.clientX, e.clientY, [item]);
  });

  // ---- dragging text out of the editor onto the Darlings tab --------------------------------------
  editorEl.addEventListener('dragstart', () => {
    const s = getSelection();
    const sid = sceneId();
    if (!sid || !s.rangeCount || s.isCollapsed || !editorEl.contains(s.anchorNode)) return;
    const range = s.getRangeAt(0).cloneRange();
    const cap = capture(range, null);
    if (!cap) return;
    emw.dragItem = { kind: 'text', id: sid, origin: 'manuscript', capture: cap, range };
  });
  // Dropping inside the editor keeps its normal move behaviour. Dropping on the tab uses the
  // 'copy' effect, so the browser leaves the text alone and sendText removes it as one undo step.
  editorEl.addEventListener('dragend', () => { emw.dragItem = null; });

  const tab = $('.tab[data-view="darlings"]');
  for (const type of ['dragenter', 'dragover']) {
    tab.addEventListener(type, (e) => {
      if (!emw.dragItem) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = emw.dragItem.kind === 'text' ? 'copy' : 'move';
      tab.classList.add('drop-over');
    });
  }
  tab.addEventListener('dragleave', () => tab.classList.remove('drop-over'));
  tab.addEventListener('drop', (e) => {
    tab.classList.remove('drop-over');
    const item = emw.dragItem;
    if (!item) return;
    e.preventDefault();
    emw.dragItem = null;   // the dragged element may be gone before dragend fires
    if (item.kind === 'text') sendText(item.capture, { range: item.range });
    else send(item.kind, item.id, { origin: item.origin });   // stays on the current view
  });

  // ---- Ctrl+Shift+D: send whatever is in front of the writer -----------------------------------------
  function sendCurrent() {
    const ae = document.activeElement;
    const v = emw.view();
    if (v === 'manuscript') {
      if (ae === editorEl && sceneId()) {
        const s = getSelection();
        return s.rangeCount && !s.isCollapsed ? sendSelection() : sendParagraph();
      }
      const card = ae && ae.closest ? ae.closest('.cv-card') : null;
      if (card) return send('scene', card.dataset.id, { origin: 'manuscript' });
      const d = emw.curDoc?.();
      if (d) return send(d.kind, d.item.id, { origin: 'manuscript' });
    } else if (v === 'timeline') {
      const card = ae && ae.closest ? ae.closest('.card') : null;
      if (card) return send('scene', card.dataset.id, { origin: 'timeline' });
    } else if (v === 'characters' && emw.familyTree && emw.familyTree.active()) {
      // Part 7i: in the family-tree mode the character list is hidden, so the thing in front of the writer is the family.
      const id = emw.familyTree.selected();
      if (id) return send('family', id, { origin: 'characters' });
    } else if (S.KINDS.includes(v)) {
      const li = $(`#view-${v} .ev-item[aria-current="true"]`);
      if (li) return send(S.KIND_ONE[v], li.dataset.id, { origin: v });
    }
    emw.toast('Select something to send to Darlings');
    return null;
  }
  emw.actions.sendToDarlings = sendCurrent;
  emw.keys.register({ id: 'sendToDarlings', label: 'Send to Darlings', group: 'Edit', keys: 'Ctrl+Shift+D' });

  // ---- the Darlings tab ------------------------------------------------------------------------------
  const listEl = $('#dl-list');
  const emptyEl = $('#dl-empty');
  const previewEl = $('#dl-preview');
  const searchEl = $('#dl-search');
  const filterEl = $('#dl-filter');
  const countEl = $('#dl-count');
  let previewFor = null;
  let rafId = 0;
  let token = 0;

  const fromText = (d) => `from ${d.restore.from || ORIGIN_LABEL[d.origin] || d.origin}`;
  const hay = (d) => [d.label, d.preview, d.restore.from, KIND_LABEL[d.kind], ORIGIN_LABEL[d.origin]].join('\n').toLowerCase();

  function colourOf(d) {
    const p = d.payload;
    if (d.kind === 'text') return 'var(--accent)';
    if (d.kind === 'plotline') return p.plotline.color;
    if (d.kind === 'tag') return p.entity.color || 'var(--muted)';
    if (d.kind === 'family') return p.family.color || 'var(--muted)';
    if (d.kind === 'scene') return p.scene.color || S.find.plotline(p.scene.plotline)?.color || 'var(--muted)';
    return 'var(--muted)';
  }

  function fillFilter() {
    const all = S.data.darlings;
    const opts = [new Option(`All (${all.length})`, '')];
    for (const o of Object.keys(ORIGIN_LABEL)) opts.push(new Option(`${ORIGIN_LABEL[o]} (${all.filter((d) => d.origin === o).length})`, o));
    filterEl.replaceChildren(...opts);
    filterEl.value = filter;
  }

  function card(d) {
    const c = el('div', 'dl-card');
    c.dataset.id = d.id;
    c.tabIndex = 0;
    c.setAttribute('role', 'listitem');
    c.setAttribute('aria-current', String(d.id === sel));
    c.setAttribute('aria-label', `${KIND_LABEL[d.kind]}: ${d.label}`);
    c.style.setProperty('--c', colourOf(d));
    c.append(el('div', 'dl-kind', KIND_LABEL[d.kind]), el('div', 'dl-title', d.label));
    if (d.preview && d.preview !== d.label) c.append(el('div', 'dl-prev', d.preview));
    c.append(el('div', 'dl-meta', `${fromText(d)} · ${fmtDate(d.createdAt)}`));
    const acts = el('div', 'dl-actions');
    const r = el('button', 'dl-restore', 'Restore');
    r.type = 'button';
    const x = el('button', 'dl-del', 'Delete forever');
    x.type = 'button';
    acts.append(r, x);
    c.append(acts);
    return c;
  }

  function render() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (!S.data) return;
    fillFilter();
    const all = S.data.darlings;
    const sx = emw.snapshots;
    const showD = mode !== 'snapshots';
    // Snapshots have no "sent from", so choosing a place in the filter leaves them out.
    const showS = !!sx && mode !== 'darlings' && !filter;
    filterEl.hidden = mode === 'snapshots';
    const list = showD ? all.filter((d) => (!filter || d.origin === filter) && (!query || hay(d).includes(query))) : [];
    if (sel && !all.some((d) => d.id === sel)) sel = '';
    const focused = document.activeElement?.closest?.('.dl-card')?.dataset.id;
    // Darlings and snapshots share one list, newest first.
    const items = list.map((d) => ({ at: d.createdAt || 0, node: card(d) }));
    const snapShown = showS ? sx.cards(query) : [];
    items.push(...snapShown);
    items.sort((a, b) => b.at - a.at);
    listEl.replaceChildren(...items.map((i) => i.node));
    if (focused) listEl.querySelector(`.dl-card[data-id="${focused}"]`)?.focus();
    const have = (showD ? all.length : 0) + (showS ? sx.total() : 0);
    emptyEl.hidden = have > 0;
    listEl.hidden = !have;
    if (have && !items.length) { emptyEl.hidden = false; emptyEl.textContent = mode === 'snapshots' ? 'No snapshots match.' : 'Nothing matches.'; }
    else if (mode === 'snapshots') emptyEl.textContent = `No snapshots yet. Press ${emw.keys.display('save') || 'Save and snapshot (File menu)'} to keep a copy of the whole project.`;
    else emptyEl.textContent = 'Nothing here yet. Right-click something, or drag it onto the Darlings tab.';
    const parts = [];
    if (showD) parts.push(list.length === all.length ? plural(all.length, 'darling') : `${list.length} of ${plural(all.length, 'darling')}`);
    if (showS) parts.push(sx.countText(snapShown.length));
    countEl.textContent = parts.join(' · ');
    const snapSel = showS || mode === 'snapshots' ? sx?.selected() : '';
    if (snapSel) { previewFor = null; sx.renderPreview(previewEl); }
    else if (previewFor !== sel || (sel && !previewEl.firstChild)) renderPreview();
  }
  const schedule = () => { if (!rafId) rafId = requestAnimationFrame(render); };

  // Sanitised HTML goes in as parsed nodes, never as a string assigned to innerHTML.
  function addHtml(host, html, cls = 'dl-body') {
    const clean = html && html.trim() ? emw.sanitize(html) : '';
    if (!clean) return false;
    const box = el('div', cls);
    box.append(...new DOMParser().parseFromString(clean, 'text/html').body.childNodes);
    host.append(box);
    return true;
  }
  const addList = (host, title, items) => {
    if (!items.length) return;
    host.append(el('h3', 'dl-h', title));
    const ul = el('ul', 'dl-ul');
    for (const t of items) ul.append(el('li', '', t));
    host.append(ul);
  };

  async function renderPreview() {
    const my = ++token;
    previewFor = sel;
    const d = sel ? S.findDarling(sel) : null;
    if (!d) { previewEl.replaceChildren(el('p', 'hint', 'Select a darling to preview it.')); return; }
    const head = el('header', 'dl-ph');
    head.append(el('div', 'dl-kind', KIND_LABEL[d.kind]), el('h2', 'dl-pt', d.label), el('p', 'dl-meta', `${fromText(d)} · ${fmtDate(d.createdAt)}`));
    const acts = el('div', 'dl-actions');
    const r = el('button', 'dl-restore', 'Restore');
    r.type = 'button';
    r.dataset.id = d.id;
    const x = el('button', 'dl-del shown', 'Delete forever');
    x.type = 'button';
    x.dataset.id = d.id;
    acts.append(r, x);
    head.append(acts);
    const body = el('div', 'dl-pbody');
    previewEl.replaceChildren(head, body);

    const p = d.payload;
    const read = async (key) => { try { return (await emw.files.read(key)) || ''; } catch { return ''; } };
    let html = '';
    if (d.kind === 'text') html = await read('darling-' + d.id);
    else if (d.kind === 'scene') {
      if (p.scene.description.trim()) body.append(el('p', 'dl-desc', p.scene.description.trim()));
      html = await read(p.scene.id);
    } else if (d.kind === 'chapter') {
      if (p.chapter.synopsis.trim()) body.append(el('p', 'dl-desc', p.chapter.synopsis.trim()));
      addList(body, plural(p.chapter.scenes.length, 'scene'), p.chapter.scenes.map(sceneName));
    } else if (d.kind === 'plotline') {
      addList(body, plural(p.scenes.length, 'scene'), p.scenes.map((x) => sceneName(x.scene)));
    } else if (S.ENTITY_KIND[d.kind]) {
      const e = p.entity;
      if (e.short) body.append(el('p', 'dl-desc', e.short));
      if ((e.aliases || []).length) body.append(el('p', 'dl-desc', 'Also known as ' + e.aliases.join(', ')));
      addList(body, 'Attributes', (e.attributes || []).filter((a) => a.k || a.v).map((a) => `${a.k}: ${a.v}`));
      html = await read(e.id);
    } else if (d.kind === 'family') {
      const f = p.family;
      const name = (id) => S.entity('characters', id)?.name || 'Unnamed character';
      addList(body, plural(f.members.length, 'member'), f.members.map((m) => name(m.id)));
      const rel = (l) => `${name(l.from)} · ${(S.relType(l.type)?.name) || 'related'} · ${name(l.to)}`;
      addList(body, plural(f.links.length, 'relationship'), f.links.map(rel));
    } else if (d.kind === 'category') {
      const names = (d.restore.entityIds || []).map((id) => S.entity(d.restore.entityKind, id)?.name).filter(Boolean);
      addList(body, `${ORIGIN_LABEL[d.restore.entityKind]} that were in it`, names);
    }
    if (my !== token) return;   // the writer picked something else while the file loaded
    if (html) addHtml(body, html);
  }

  function pick(id) {
    emw.snapshots?.select('');
    sel = id;
    for (const c of listEl.children) c.setAttribute('aria-current', String(c.dataset.id === id));
    renderPreview();
  }

  function cardMenu(id, x, y) {
    emw.menu(x, y, [
      { label: 'Restore', run: () => restore(id) },
      null,
      { label: 'Delete forever', danger: true, run: () => remove(id) }
    ]);
  }

  listEl.addEventListener('click', (e) => {
    const c = e.target.closest('.dl-card');
    if (!c || c.dataset.snap) return;   // snapshot cards are handled in snapshots.js
    if (e.target.closest('.dl-restore')) { restore(c.dataset.id); return; }
    if (e.target.closest('.dl-del')) { remove(c.dataset.id); return; }
    pick(c.dataset.id);
  });
  listEl.addEventListener('keydown', (e) => {
    const c = e.target.closest?.('.dl-card');
    if (!c || c.dataset.snap || e.target !== c) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(c.dataset.id); }
    else if (e.key === 'Delete') { e.preventDefault(); remove(c.dataset.id); }
  });
  listEl.addEventListener('contextmenu', (e) => {
    const c = e.target.closest('.dl-card');
    if (!c || c.dataset.snap) return;
    e.preventDefault();
    cardMenu(c.dataset.id, e.clientX, e.clientY);
  });
  previewEl.addEventListener('click', (e) => {
    const r = e.target.closest('.dl-restore');
    const x = e.target.closest('.dl-del');
    if (r) restore(r.dataset.id); else if (x) remove(x.dataset.id);
  });
  searchEl.addEventListener('input', () => { query = searchEl.value.trim().toLowerCase(); schedule(); });
  filterEl.addEventListener('change', () => { filter = filterEl.value; schedule(); });
  modesEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) { setMode(b.dataset.mode); render(); }
  });
  // Arrow keys move between the three choices, as in any tab strip.
  modesEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...modesEl.children];
    const next = tabs[(tabs.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    e.preventDefault();
    next.focus();
    next.click();
  });

  // ---- counts in the bottom bar --------------------------------------------------------------------------
  const countBtn = $('#st-darlings');
  const stWords = $('#st-words');
  const stTotal = $('#st-total');
  function updateStats() {
    if (!S.data) return;
    const v = emw.view();
    const n = v === 'darlings' ? S.data.darlings.length : S.darlingCount(v);
    countBtn.hidden = n === 0;
    countBtn.textContent = plural(n, 'darling');
    // Word counts only mean something on the manuscript and the timeline.
    const words = v === 'manuscript' || v === 'timeline';
    stWords.hidden = !words;
    stTotal.hidden = !words;
  }
  countBtn.addEventListener('click', () => openDarlings(emw.view() === 'darlings' ? '' : emw.view()));

  // ---- the inspector's Darlings panel ----------------------------------------------------------------------
  const inspEl = $('#insp-darlings');
  const inspTab = $('.insp-tabbar [data-tab="darlings"]');
  let inspRaf = 0;

  function inspRow(d) {
    const row = el('div', 'lf-row dl-irow');
    const open = el('button', 'lf-open');
    open.type = 'button';
    open.title = 'Show in Darlings';
    open.append(el('b', 'dl-clamp', d.preview || d.label), el('span', '', `Sent ${fmtDate(d.createdAt)}`));
    open.addEventListener('click', () => openDarlings('', d.id));
    const acts = el('div', 'dl-irow-actions');
    const r = el('button', 'dl-restore', 'Restore');
    r.type = 'button';
    r.addEventListener('click', () => restore(d.id));
    const x = el('button', 'quiet-btn dl-idel', 'Delete forever');
    x.type = 'button';
    x.addEventListener('click', () => remove(d.id));
    acts.append(r, x);
    row.append(open, acts);
    return row;
  }

  function renderInspector() {
    inspRaf = 0;
    if (!S.data) return;
    const d = emw.curDoc?.();
    let groups = [];
    let hint = '';
    if (d && d.kind === 'scene') {
      groups = [{ title: '', items: S.darlingsFor({ sceneId: d.item.id }) }];
      hint = 'Nothing cut from this scene.';
    } else if (d && d.kind === 'chapter') {
      groups = d.item.scenes.map((s) => ({ title: sceneName(s), items: S.darlingsFor({ sceneId: s.id }) }));
      hint = 'Nothing cut from this chapter’s scenes.';
    }
    groups = groups.filter((g) => g.items.length);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    inspTab.textContent = total ? `Darlings (${total})` : 'Darlings';
    const nodes = [];
    if (!total) nodes.push(el('p', 'hint', hint || 'Open a scene to see what was cut from it.'));
    for (const g of groups) {
      const sec = el('div', 'dl-igroup');
      if (g.title) sec.append(el('div', 'dl-ih', g.title));
      const list = el('div', 'lf-list');
      list.append(...g.items.map(inspRow));
      sec.append(list);
      nodes.push(sec);
    }
    inspEl.replaceChildren(...nodes);
  }
  const scheduleInspector = () => { if (!inspRaf) inspRaf = requestAnimationFrame(renderInspector); };

  // ---- keeping in step ----------------------------------------------------------------------------------------
  S.on(() => {
    if (emw.view() === 'darlings') schedule();
    updateStats();
    scheduleInspector();
  });
  emw.onView((name) => {
    if (name === 'darlings') render();
    updateStats();
  });
  // The store has no 'loaded' event; the first document opening is the first moment there is data.
  document.addEventListener('emw:doc', () => { updateStats(); scheduleInspector(); });
  // A different book: the old search, filter and preview selection mean nothing there.
  emw.book.onSwitch(() => {
    filter = '';
    query = '';
    sel = '';
    setMode('all');
    searchEl.value = '';
    updateStats();
    scheduleInspector();
  });
})();
