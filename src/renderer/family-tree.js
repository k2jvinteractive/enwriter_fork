// Family trees, part 1 (part 7i): the families panel and the relationship types manager.
// The data and every change to it live in the store (families, relationTypes). This file draws the
// left panel inside the Characters view and the Relationships dialog. Part 7j adds the canvas in
// `emw.familyTree.canvas` (the host element) and listens with `emw.familyTree.onSelect`.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const $ = (s, r = document) => r.querySelector(s);
  const root = $('#view-characters');
  const NS = 'http://www.w3.org/2000/svg';

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const btn = (cls, label, text) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (label) { b.setAttribute('aria-label', label); b.title = label; }
    return b;
  };
  const icon = (id) => {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'ic');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(NS, 'use');
    u.setAttribute('href', '#' + id);
    s.append(u);
    return s;
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

  // ---- colours -----------------------------------------------------------------------------------
  // What a relationship type is drawn in. A built-in with no colour of its own uses the theme's token;
  // anything the writer chose goes through the same --hue-mix blend as plotlines and tags, so a pale
  // colour stays visible on the light theme and the stored value is never changed.
  const relColor = (t) => {
    if (t && t.color) return `color-mix(in srgb, ${t.color} var(--hue-mix), var(--ink))`;
    return `var(--rel-${t && t.builtin ? t.id : S.REL_NEUTRAL})`;
  };
  // The hex a colour input should start from: the writer's colour, else the token's value in the current theme.
  const relHex = (t) => {
    if (t.color) return t.color;
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--rel-${t.builtin ? t.id : S.REL_NEUTRAL}`).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : '#888888';
  };

  // ---- state -------------------------------------------------------------------------------------
  let on = false;            // the Characters view is showing family trees (view state, not data)
  let sel = '';
  let lost = '';             // the selected family left (deleted); if undo brings it back it is selected again
  let selIndex = 0;
  let stale = true;
  const thumbs = new Map();  // family id -> data URL
  const selectListeners = [];
  const keyOf = () => emw.book.key('family');
  const panelKey = () => emw.book.key('familyPanel');
  const families = () => (S.data && S.data.families) || [];

  // ---- skeleton ----------------------------------------------------------------------------------
  const host = el('div', 'ft');
  host.hidden = true;
  host.innerHTML = `
    <aside class="ft-panel" id="ft-panel" aria-label="Family trees">
      <header class="ft-head">
        <h1>Family trees</h1>
        <button type="button" class="ft-add" title="Add a family tree" aria-label="Add a family tree">+</button>
        <button type="button" class="ft-collapse" title="Hide this panel" aria-label="Hide the family trees panel" aria-expanded="true" aria-controls="ft-panel">«</button>
      </header>
      <ul class="ft-list" aria-label="Families"></ul>
      <div class="ft-empty" hidden>
        <p>No family trees yet</p>
        <button type="button" class="ft-add-empty">Add a family</button>
      </div>
      <footer class="ft-foot"><button type="button" class="ft-rel" aria-haspopup="dialog"><svg class="ic" aria-hidden="true"><use href="#i-link"/></svg><span>Relationships</span></button></footer>
    </aside>
    <section class="ft-stage" aria-label="Family tree">
      <div class="ft-bar">
        <button type="button" class="ft-back">‹ Back to characters</button>
        <button type="button" class="ft-expand" title="Show the family trees panel" aria-label="Show the family trees panel" aria-expanded="false" aria-controls="ft-panel" hidden>»</button>
        <h2 class="ft-title"></h2>
      </div>
      <div class="ft-canvas"></div>
    </section>
    <input type="file" accept="image/*" class="ft-file" hidden>`;
  root.append(host);

  const panel = $('.ft-panel', host);
  const listEl = $('.ft-list', host);
  const emptyEl = $('.ft-empty', host);
  const titleEl = $('.ft-title', host);
  const canvasEl = $('.ft-canvas', host);
  const fileEl = $('.ft-file', host);
  const collapseBtn = $('.ft-collapse', host);
  const expandBtn = $('.ft-expand', host);
  let imageFor = '';

  // The way in: a row under the Characters tools.
  const entry = el('div', 'ft-entry');
  const entryBtn = btn('ft-open');
  entryBtn.append(icon('i-tree'), el('span', '', 'Family trees'));
  entry.append(entryBtn);
  const tools = $('.ev-tools', root);
  if (tools) tools.after(entry); else root.prepend(entry);

  // ---- the panel list ------------------------------------------------------------------------------
  function loadThumb(id) {
    if (thumbs.has(id)) return Promise.resolve(thumbs.get(id));
    return Promise.resolve(emw.files.read('thumb-fam-' + id)).then((url) => { thumbs.set(id, url || ''); return url || ''; }, () => '');
  }

  function actions(f) {
    const acts = el('div', 'ft-acts');
    const rename = btn('ft-act', `Rename ${f.name || 'family'}`);
    rename.dataset.act = 'rename';
    rename.append(icon('i-pencil'));
    const image = btn('ft-act', f.hasImage ? 'Change image' : 'Add an image');
    image.dataset.act = 'image';
    image.append(icon('i-image'));
    const colour = el('label', 'ft-act ft-colour');
    colour.title = 'Colour';
    const sw = el('i', 'ft-sw');
    sw.setAttribute('aria-hidden', 'true');
    const input = el('input');
    input.type = 'color';
    input.value = f.color;
    input.setAttribute('aria-label', `Colour for ${f.name || 'family'}`);
    colour.append(sw, input);
    acts.append(rename, image, colour);
    if (f.hasImage) {
      const off = btn('ft-act', 'Remove image');
      off.dataset.act = 'unimage';
      off.append(icon('i-image-off'));
      acts.append(off);
    }
    const del = btn('ft-act ft-del', `Delete ${f.name || 'family'}`);
    del.dataset.act = 'delete';
    del.append(icon('i-trash'));
    acts.append(del);
    return acts;
  }

  function item(f, tab) {
    const li = el('li', 'ft-item');
    li.dataset.id = f.id;
    li.draggable = true;
    li.tabIndex = tab ? 0 : -1;
    li.setAttribute('aria-current', String(f.id === sel));
    li.style.setProperty('--fc', f.color);
    const stripe = el('i', 'ft-stripe');
    stripe.setAttribute('aria-hidden', 'true');
    const thumb = el('span', 'ft-thumb');
    thumb.setAttribute('aria-hidden', 'true');
    thumb.hidden = !f.hasImage;
    if (f.hasImage) {
      loadThumb(f.id).then((url) => {
        if (!url || !thumb.isConnected) return;
        const img = el('img');
        img.alt = '';
        img.src = url;
        thumb.replaceChildren(img);
      });
    }
    const main = el('div', 'ft-main');
    main.append(el('span', 'ft-name', f.name || 'Unnamed family'));
    const count = el('span', 'ft-count', plural(f.members.length, 'member'));
    main.append(count, actions(f));
    li.append(stripe, thumb, main);
    return li;
  }

  function render() {
    stale = false;
    if (!S.data) return;
    const fams = families();
    const idx = fams.findIndex((f) => f.id === sel);
    if (idx >= 0) selIndex = idx;
    const focusId = document.activeElement?.closest?.('.ft-item')?.dataset.id || '';
    const tabId = fams.some((f) => f.id === sel) ? sel : (fams[0] && fams[0].id);
    listEl.replaceChildren(...fams.map((f) => item(f, f.id === tabId)));
    if (focusId && host.contains(document.activeElement) === false) {
      // The element that had focus was replaced; give focus to its successor.
      listEl.querySelector(`.ft-item[data-id="${focusId}"]`)?.focus();
    }
    emptyEl.hidden = fams.length > 0;
    listEl.hidden = fams.length === 0;
  }

  // While a colour picker is open the list must not be rebuilt (that would close it), so changes of
  // colour and counts are applied to the rows that are already there.
  function patchRows() {
    for (const f of families()) {
      const li = listEl.querySelector(`.ft-item[data-id="${f.id}"]`);
      if (!li) continue;
      li.style.setProperty('--fc', f.color);
      const c = $('.ft-count', li);
      if (c) c.textContent = plural(f.members.length, 'member');
    }
  }

  function renderStage() {
    const f = S.family(sel);
    titleEl.textContent = f ? (f.name || 'Unnamed family') : '';
    canvasEl.dataset.family = f ? f.id : '';
    // Part 7j replaces this note with the canvas. Until then the stage says what is selected.
    if (!canvasEl.querySelector('.ft-canvas-live')) {
      const note = el('p', 'ft-note');
      note.setAttribute('role', 'status');
      note.textContent = f
        ? `${f.name || 'Unnamed family'}: ${plural(f.members.length, 'member')}, ${plural(f.links.length, 'relationship')}. The canvas for drawing this tree is not available yet.`
        : 'Add a family on the left to start a tree.';
      canvasEl.replaceChildren(note);
    }
  }

  function applyPanel() {
    const hidden = lsGet(panelKey()) === '1';
    panel.hidden = hidden;
    collapseBtn.setAttribute('aria-expanded', String(!hidden));
    expandBtn.hidden = !hidden;
    expandBtn.setAttribute('aria-expanded', String(!hidden));
  }
  function setPanel(hidden) {
    lsSet(panelKey(), hidden ? '1' : '');
    applyPanel();
    (hidden ? expandBtn : collapseBtn).focus();
  }

  function applyMode() {
    root.classList.toggle('ft-mode', on);
    host.hidden = !on;
    entryBtn.setAttribute('aria-pressed', String(on));
  }

  // ---- selection ------------------------------------------------------------------------------------
  function select(id, { focus = false } = {}) {
    lost = '';
    sel = S.family(id) ? id : '';
    lsSet(keyOf(), sel);
    render();
    renderStage();
    selectListeners.forEach((cb) => { try { cb(sel); } catch { /* a listener must not break the others */ } });
    if (focus) listEl.querySelector(`.ft-item[data-id="${sel}"]`)?.focus();
  }

  function open(familyId) {
    if (!(emw.book && emw.book.id) || !S.data) return;
    on = true;
    applyMode();
    applyPanel();
    const saved = lsGet(keyOf());
    const pick = [familyId, sel, saved].find((id) => id && S.family(id)) || (families()[0] && families()[0].id) || '';
    emw.showView('characters');
    select(pick);
    const li = listEl.querySelector(`.ft-item[data-id="${sel}"]`);
    if (li) li.focus(); else $('.ft-add', host).focus();
  }

  function close() {
    on = false;
    applyMode();
    entryBtn.focus();
  }

  // ---- adding, renaming, deleting -------------------------------------------------------------------------
  async function addFamily() {
    const name = await emw.ask({ message: 'Name for the new family', input: '', okLabel: 'Create' });
    if (name == null || !name.trim()) return;
    select(S.addFamily(name.trim()), { focus: true });
  }

  function renameFamily(id) {
    const name = listEl.querySelector(`.ft-item[data-id="${id}"] .ft-name`);
    const f = S.family(id);
    if (!name || !f) return;
    emw.rename(name, { value: f.name, placeholder: 'Family name', onCommit: (v) => { if (v) S.renameFamily(id, v); }, onDone: () => { render(); renderStage(); listEl.querySelector(`.ft-item[data-id="${id}"]`)?.focus(); } });
  }

  // Deleting sends the family to Darlings, with the usual Undo in the toast. No confirmation.
  function deleteFamily(id) {
    if (!S.family(id)) return;
    if (emw.darlings) emw.darlings.send('family', id, { origin: 'characters' });
    else { S.deleteFamily(id); emw.toast('Family sent to Darlings', { action: { label: 'Undo', run: () => { S.undo(); } } }); }
  }

  function chooseImage(id) { imageFor = id; fileEl.click(); }
  fileEl.addEventListener('change', async () => {
    const f = fileEl.files[0];
    const id = imageFor;
    fileEl.value = '';
    if (!f || !S.family(id)) return;
    try {
      const url = await emw.imageToDataUrl(f, 320);
      await emw.files.write('thumb-fam-' + id, url);   // the file first, then the store, as for character thumbnails
      thumbs.set(id, url);
      S.setFamilyImage(id);
      render();   // the flag may already have been true; the picture itself changed
    } catch (err) { emw.toast(err.message || 'That image could not be used'); }
  });

  // ---- events on the list ---------------------------------------------------------------------------------------
  listEl.addEventListener('click', (e) => {
    const li = e.target.closest('.ft-item');
    if (!li) return;
    const act = e.target.closest('[data-act]');
    const id = li.dataset.id;
    if (e.target.closest('.ft-colour')) return;   // the colour input does its own thing
    if (act) {
      const a = act.dataset.act;
      if (a === 'rename') renameFamily(id);
      else if (a === 'image') chooseImage(id);
      else if (a === 'unimage') S.removeFamilyImage(id);
      else if (a === 'delete') deleteFamily(id);
      return;
    }
    if (e.target.closest('.rename')) return;
    if (id !== sel) select(id);
  });
  listEl.addEventListener('input', (e) => {
    const input = e.target.closest('.ft-colour input');
    const li = e.target.closest('.ft-item');
    if (input && li) S.setFamilyColor(li.dataset.id, input.value);
  });
  listEl.addEventListener('keydown', (e) => {
    const li = e.target.closest('.ft-item');
    if (!li || e.target !== li) return;   // keys typed in the rename box or on a button are theirs
    const items = [...listEl.querySelectorAll('.ft-item')];
    const at = items.indexOf(li);
    const go = (n) => {
      const t = items[Math.max(0, Math.min(items.length - 1, n))];
      if (!t) return;
      items.forEach((x) => { x.tabIndex = x === t ? 0 : -1; });
      t.focus();
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); go(at + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(li.dataset.id, { focus: true }); }
    else if (e.key === 'Delete') { e.preventDefault(); deleteFamily(li.dataset.id); }
    else if (e.key === 'F2') { e.preventDefault(); renameFamily(li.dataset.id); }
  });
  listEl.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('.ft-item');
    if (!li) return;
    e.preventDefault();
    const id = li.dataset.id;
    const f = S.family(id);
    emw.menu(e.clientX, e.clientY, [
      { label: 'Rename', run: () => renameFamily(id) },
      { label: f && f.hasImage ? 'Change image…' : 'Add image…', run: () => chooseImage(id) },
      { label: 'Remove image', disabled: !(f && f.hasImage), run: () => S.removeFamilyImage(id) },
      null,
      { label: 'Delete', danger: true, run: () => deleteFamily(id) }
    ]);
  });

  // Drag to reorder (the 3px accent bar), and drag onto the Darlings tab to delete.
  let dragId = '';
  const clearMarks = () => listEl.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  const after = (li, e) => { const r = li.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('.ft-item');
    if (!li) return;
    dragId = li.dataset.id;
    emw.dragItem = { kind: 'family', id: dragId, origin: 'characters' };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  listEl.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const li = e.target.closest('.ft-item');
    clearMarks();
    if (!li || li.dataset.id === dragId) return;
    e.preventDefault();
    li.classList.add(after(li, e) ? 'drop-after' : 'drop-before');
  });
  listEl.addEventListener('drop', (e) => {
    const li = e.target.closest('.ft-item');
    clearMarks();
    if (!dragId || !li || li.dataset.id === dragId) return;
    e.preventDefault();
    const at = families().findIndex((f) => f.id === li.dataset.id) + (after(li, e) ? 1 : 0);
    S.reorderFamilies(dragId, at);
  });
  listEl.addEventListener('dragend', () => { dragId = ''; emw.dragItem = null; clearMarks(); });

  // ---- buttons ----------------------------------------------------------------------------------------------------
  $('.ft-add', host).addEventListener('click', addFamily);
  $('.ft-add-empty', host).addEventListener('click', addFamily);
  collapseBtn.addEventListener('click', () => setPanel(true));
  expandBtn.addEventListener('click', () => setPanel(false));
  $('.ft-back', host).addEventListener('click', close);
  entryBtn.addEventListener('click', () => open());
  $('.ft-rel', host).addEventListener('click', () => openRelationships());

  // ---- the Relationships manager -----------------------------------------------------------------------------------
  // A dialog like Settings. Deleting a type cannot offer its Undo in the toast (the page behind a modal
  // dialog does not take clicks), so the dialog shows its own note with an Undo button.
  let dlg = null;
  let body = null;
  let note = null;
  let adding = false;

  const sameName = (name, exceptId) => S.data.relationTypes.some((t) => t.id !== exceptId && t.name.toLowerCase() === name.trim().toLowerCase());
  const usedBy = (id) => families().reduce((n, f) => n + f.links.filter((l) => l.type === id).length, 0);

  function showNote(text, undo) {
    note.replaceChildren(el('span', '', text));
    if (undo) {
      const u = btn('quiet-btn', '', 'Undo');
      u.addEventListener('click', () => { undo(); note.hidden = true; renderRel(); });
      note.append(u);
    }
    note.hidden = false;
  }

  function typeRow(t) {
    const row = el('div', 'rel-row');
    row.dataset.id = t.id;
    let resetBtn = null;
    const swatch = el('label', 'rel-colour');
    swatch.title = 'Colour';
    const ci = el('input');
    ci.type = 'color';
    ci.value = relHex(t);
    ci.setAttribute('aria-label', `Colour for ${t.name}`);
    ci.addEventListener('input', () => {
      S.updateRelationType(t.id, { color: ci.value });
      line.style.setProperty('--rc', relColor(S.relType(t.id)));
      if (resetBtn) resetBtn.hidden = false;   // not a redraw: that would close the picker the writer is dragging in
    });
    swatch.append(ci);
    const line = el('i', 'rel-line');
    line.setAttribute('aria-hidden', 'true');
    line.style.setProperty('--rc', relColor(t));
    row.append(swatch, line);

    if (t.builtin) {
      row.append(el('span', 'rel-name', cap(t.name)), el('span', 'rel-inv', t.directed ? `Read from the other end: ${t.inverse}` : (t.inverse && t.inverse !== t.name ? `Also called ${t.inverse}` : '')),
        el('span', 'rel-dir', t.directed ? 'Directed' : 'Undirected'));
      const end = el('div', 'rel-end');
      end.append(el('span', 'rel-tag', 'Built in'));
      resetBtn = btn('quiet-btn', '', 'Reset colour');
      resetBtn.hidden = !t.color;
      resetBtn.addEventListener('click', () => { S.updateRelationType(t.id, { color: '' }); renderRel(); });
      end.append(resetBtn);
      row.append(end);
      return row;
    }

    const name = el('input', 'rel-name-in');
    name.value = t.name;
    name.placeholder = 'Name';
    name.maxLength = 60;
    name.spellcheck = false;
    name.setAttribute('aria-label', 'Relationship name');
    name.addEventListener('input', () => {
      const bad = !name.value.trim() || sameName(name.value, t.id);
      name.setAttribute('aria-invalid', String(bad));
      if (!bad) S.updateRelationType(t.id, { name: name.value }, { coalesce: `rel:${t.id}:name` });
    });
    name.addEventListener('blur', () => { const cur = S.relType(t.id); if (cur) { name.value = cur.name; name.removeAttribute('aria-invalid'); } });
    const inv = el('input', 'rel-inv-in');
    inv.value = t.inverse;
    inv.placeholder = 'Read from the other end (optional)';
    inv.maxLength = 60;
    inv.spellcheck = false;
    inv.setAttribute('aria-label', `Read from the other end, for ${t.name}`);
    inv.addEventListener('input', () => S.updateRelationType(t.id, { inverse: inv.value }, { coalesce: `rel:${t.id}:inv` }));
    const dir = el('select', 'rel-dir-in');
    dir.setAttribute('aria-label', `Direction of ${t.name}`);
    dir.append(new Option('Undirected', 'no'), new Option('Directed', 'yes'));
    dir.value = t.directed ? 'yes' : 'no';
    dir.addEventListener('change', () => S.updateRelationType(t.id, { directed: dir.value === 'yes' }));
    const end = el('div', 'rel-end');
    const used = usedBy(t.id);
    if (used) end.append(el('span', 'rel-used', plural(used, 'link')));
    const del = btn('ft-act', `Delete ${t.name}`);
    del.append(icon('i-trash'));
    del.addEventListener('click', () => {
      const moved = S.deleteRelationType(t.id);
      if (moved === false) return;
      renderRel();
      showNote(`Deleted “${t.name}”.${moved ? ` ${plural(moved, 'relationship')} now ${moved === 1 ? 'uses' : 'use'} Related.` : ''}`, () => { S.undo(); });
    });
    end.append(del);
    row.append(name, inv, dir, end);
    return row;
  }

  function addForm() {
    if (!adding) {
      const b = btn('rel-add', '', '+ Add a relationship type');
      b.addEventListener('click', () => { adding = true; renderRel(); $('.rel-new-name', body).focus(); });
      return b;
    }
    const form = el('form', 'rel-form');
    form.noValidate = true;
    const name = el('input', 'rel-new-name');
    name.placeholder = 'Name, for example “guardian”';
    name.maxLength = 60;
    name.spellcheck = false;
    name.setAttribute('aria-label', 'Name of the new relationship type');
    const inv = el('input');
    inv.placeholder = 'Read from the other end (optional)';
    inv.maxLength = 60;
    inv.spellcheck = false;
    inv.setAttribute('aria-label', 'How it reads from the other end');
    const colour = el('input', 'rel-new-colour');
    colour.type = 'color';
    colour.value = S.suggestRelationColor();
    colour.setAttribute('aria-label', 'Colour of the new relationship type');
    const dirLabel = el('label', 'st-check');
    const dir = el('input');
    dir.type = 'checkbox';
    dirLabel.append(dir, document.createTextNode('Directed'));
    const msg = el('p', 'rel-err');
    msg.setAttribute('role', 'status');
    const ok = btn('rel-ok', '', 'Add');
    ok.type = 'submit';
    const cancel = btn('quiet-btn', '', 'Cancel');
    cancel.addEventListener('click', () => { adding = false; renderRel(); });
    const actionsRow = el('div', 'rel-form-actions');
    actionsRow.append(ok, cancel);
    form.append(name, inv, colour, dirLabel, actionsRow, msg);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) { msg.textContent = 'Give the relationship a name.'; name.focus(); return; }
      if (sameName(n, '')) { msg.textContent = 'There is already a relationship type with that name.'; name.focus(); return; }
      S.addRelationType({ name: n, inverse: inv.value, color: colour.value, directed: dir.checked });
      adding = false;
      renderRel();
      showNote(`Added “${n}”.`, null);
    });
    return form;
  }

  function renderRel() {
    if (!dlg || !S.data) return;
    note.hidden = true;
    const head = el('div', 'rel-row rel-headrow');
    head.setAttribute('aria-hidden', 'true');
    head.append(el('span', '', ''), el('span', '', ''), el('span', 'lbl', 'Name'), el('span', 'lbl', 'Read from the other end'), el('span', 'lbl', 'Direction'), el('span', ''));
    body.replaceChildren(head, ...S.data.relationTypes.map(typeRow), addForm());
  }

  function openRelationships() {
    if (!S.data) return;
    if (!dlg) {
      dlg = el('dialog', 'rel-dialog');
      dlg.setAttribute('aria-label', 'Relationship types');
      const h = el('h2', 'rel-title', 'Relationships');
      const intro = el('p', 'hint', 'The kinds of link a family tree can draw between two characters. Built-in types can be recoloured but not renamed or deleted.');
      body = el('div', 'rel-body');
      note = el('div', 'rel-note');
      note.setAttribute('role', 'status');
      note.hidden = true;
      const foot = el('div', 'rel-foot');
      const close = btn('primary', '', 'Close');
      close.addEventListener('click', () => dlg.close());
      foot.append(close);
      dlg.append(h, intro, body, note, foot);
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
      dlg.addEventListener('close', () => { adding = false; $('.ft-rel', host)?.focus(); });
      document.body.append(dlg);
    }
    adding = false;
    renderRel();
    dlg.showModal();
    (dlg.querySelector('input, select, button') || dlg).focus();
  }

  // ---- keeping up with the store ---------------------------------------------------------------------------------------
  function onStore() {
    if (!on || root.hidden) { stale = true; return; }
    const fams = families();
    if (sel && !S.family(sel)) {
      lost = sel;   // deleted (or undone away); undo can bring it back
      const next = fams[Math.min(selIndex, fams.length - 1)];
      sel = next ? next.id : '';
      lsSet(keyOf(), sel);
      selectListeners.forEach((cb) => { try { cb(sel); } catch { /* ignore */ } });
    } else if (lost && S.family(lost)) { select(lost); return; }
    else if (!sel && fams.length) { sel = fams[0].id; }
    if (document.activeElement?.matches?.('.ft-colour input')) patchRows(); else render();
    renderStage();
  }
  S.on(onStore);
  emw.onView((name) => {
    if (name !== 'characters' || !on) return;
    if (stale || !listEl.children.length) { if (!S.family(sel)) sel = (families()[0] || {}).id || ''; render(); renderStage(); }
  });
  // A different book: its families, panel state and thumbnails are its own.
  emw.book.onSwitch(() => {
    on = false;
    sel = '';
    lost = '';
    selIndex = 0;
    stale = true;
    thumbs.clear();
    applyMode();
    if (dlg && dlg.open) dlg.close();
  });

  // Opening a character from anywhere (a chip, Darlings) leaves the family mode so the character shows.
  const openEntity = emw.openEntity;
  emw.openEntity = (kind, id) => { if (kind === 'characters' && on) close(); openEntity(kind, id); };

  emw.familyTree = {
    open, close, active: () => on, selected: () => sel, relColor, openRelationships,
    canvas: canvasEl,                       // part 7j draws here (give the child the class ft-canvas-live)
    onSelect: (cb) => selectListeners.push(cb)
  };
  emw.actions.openFamilyTrees = () => open();
  emw.keys.register({ id: 'openFamilyTrees', label: 'Family trees', group: 'Navigate', when: () => !document.querySelector('dialog[open]') });
  applyMode();
})();
