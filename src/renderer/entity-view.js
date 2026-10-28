// Characters, Places, Notes and Tags: one list-and-detail view, configured per kind.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const $ = (s) => document.querySelector(s);

  const CONFIG = {
    characters: { title: 'Characters', one: 'character', nameLabel: 'Name', aliases: true, thumb: true, short: true, content: true, attributes: true, tags: true, scenes: true, subtitle: 'short' },
    places: { title: 'Places', one: 'place', nameLabel: 'Name', aliases: true, thumb: true, short: true, content: true, attributes: true, tags: true, scenes: true, subtitle: 'short' },
    notes: { title: 'Notes', one: 'note', nameLabel: 'Title', content: true, tags: true, scenes: true, subtitle: 'preview' },
    tags: { title: 'Tags', one: 'tag', nameLabel: 'Name', color: true, short: true, usage: true, subtitle: 'short' }
  };
  const views = {};
  const catsOf = (kind) => S.data.categories[kind];

  function detailHtml(cfg) {
    return `
      <div class="ev-empty">Nothing selected yet. Use the + button to add a ${cfg.one}.</div>
      <article class="ev-card" hidden>
        <div class="ev-top">
          <div class="ev-side">
            ${cfg.tags ? '<div class="ev-block"><span class="lbl">Tags</span><div class="ev-tags"></div></div>' : ''}
            ${cfg.scenes ? '<div class="ev-block"><span class="lbl">Scenes</span><div class="ev-scenes"></div></div>' : ''}
            ${cfg.usage ? '<div class="ev-block"><span class="lbl">Used by</span><div class="ev-usage"></div></div>' : ''}
          </div>
          <div class="ev-main">
            <div class="ev-row">
              <label class="f grow"><span class="lbl">${cfg.nameLabel}</span><input class="ev-name" spellcheck="false"></label>
              <label class="f"><span class="lbl">Category</span><select class="ev-cat-sel"></select></label>
              ${cfg.color ? '<label class="f"><span class="lbl">Colour</span><input type="color" class="ev-color"></label>' : ''}
            </div>
            ${cfg.aliases ? '<div class="f"><span class="lbl">Aliases <small>(other names the app should recognise while you write)</small></span><div class="ev-aliases"></div></div>' : ''}
            ${cfg.short ? '<label class="f"><span class="lbl">Short description</span><input class="ev-short"></label>' : ''}
            ${cfg.thumb ? `<div class="f"><span class="lbl">Thumbnail</span>
              <div class="ev-thumb"><img alt="" hidden><div class="ev-thumb-btns">
                <button type="button" class="ev-pick">Choose an image</button><button type="button" class="ev-unpick quiet-btn" hidden>Remove</button>
              </div></div><input type="file" accept="image/*" class="ev-file" hidden></div>` : ''}
          </div>
        </div>
        ${cfg.content ? `
          <div class="ev-tabs ${cfg.attributes ? '' : 'single'}" role="tablist">
            <button type="button" role="tab" data-tab="notes" aria-selected="true">${cfg.one === 'note' ? 'Content' : 'Notes'}</button>
            ${cfg.attributes ? '<button type="button" role="tab" data-tab="attributes" aria-selected="false">Attributes</button>' : ''}
          </div>
          <div class="ev-panel" data-panel="notes"><div class="ev-mini"></div></div>
          ${cfg.attributes ? '<div class="ev-panel" data-panel="attributes" hidden><div class="ev-attrs"></div><button type="button" class="ev-attr-add quiet-btn">+ Add attribute</button></div>' : ''}` : ''}
        <footer class="ev-foot"><div><button type="button" class="ev-delete danger-btn">Delete</button> <button type="button" class="ev-dup">Duplicate</button></div></footer>
      </article>`;
  }

  function createView(kind) {
    const cfg = CONFIG[kind];
    const root = $('#view-' + kind);
    root.innerHTML = `
      <aside class="ev-list">
        <header class="ev-head"><h1>${cfg.title}</h1>
          <button type="button" class="ev-new" title="New ${cfg.one}" aria-label="New ${cfg.one}">+</button></header>
        <div class="ev-tools">
          <input type="search" class="ev-filter" placeholder="Filter…" aria-label="Filter ${cfg.title.toLowerCase()}" spellcheck="false">
          <button type="button" class="ev-newcat quiet-btn">New category</button>
        </div>
        <div class="ev-groups"></div>
      </aside>
      <div class="ev-detail">${detailHtml(cfg)}</div>`;
    const q = (s) => root.querySelector(s);
    const groupsEl = q('.ev-groups');
    const empty = q('.ev-empty');
    const card = q('.ev-card');
    const nameEl = q('.ev-name');
    const catSel = q('.ev-cat-sel');
    const shortEl = q('.ev-short');
    const colorEl = q('.ev-color');
    const thumbImg = q('.ev-thumb img');
    const unpick = q('.ev-unpick');

    const lastKey = () => emw.book.key(`sel.${kind}`);   // per book
    let sel = null;
    let filter = '';
    let contentId = null;
    let dirty = false;
    let saveTimer = 0;
    let loadToken = 0;
    const thumbs = new Map();
    const cur = () => (sel ? S.entity(kind, sel) : null);
    const edit = (patch, key) => S.updateEntity(kind, sel, patch, { coalesce: `ent:${sel}:${key}` });

    // ---- left-hand list ------------------------------------------------------
    const matches = (e) => {
      if (!filter) return true;
      const hay = [e.name, e.short, ...(e.aliases || [])].join('\n').toLowerCase();
      return hay.includes(filter);
    };

    function renderList() {
      const frag = document.createDocumentFragment();
      const cats = catsOf(kind);
      const groups = cats.map((c) => ({ id: c.id, name: c.name, real: true, items: S.data[kind].filter((e) => e.category === c.id && matches(e)) }));
      const orphans = S.data[kind].filter((e) => !cats.some((c) => c.id === e.category) && matches(e));
      if (orphans.length) groups.push({ id: '', name: 'Uncategorised', real: false, items: orphans });
      for (const g of groups) {
        if (filter && !g.items.length) continue;
        const sec = document.createElement('section');
        sec.className = 'ev-group';
        sec.dataset.cat = g.id;
        const h = document.createElement('h2');
        h.className = 'ev-cat';
        const nm = document.createElement('span');
        nm.className = 'ev-cat-name';
        nm.textContent = g.name;
        h.append(nm);
        if (g.real) {
          const k = document.createElement('button');
          k.type = 'button';
          k.className = 'kebab';
          k.textContent = '⋯';
          k.setAttribute('aria-label', `Actions for ${g.name}`);
          h.append(k);
        }
        sec.append(h);
        const ul = document.createElement('ul');
        for (const e of g.items) {
          const li = document.createElement('li');
          li.className = 'ev-item';
          li.dataset.id = e.id;
          li.draggable = true;
          li.setAttribute('aria-current', String(e.id === sel));
          const top = document.createElement('div');
          top.className = 'ev-item-name';
          if (cfg.color) { const d = document.createElement('i'); d.className = 'tag-dot'; d.style.background = e.color; top.append(d); }
          top.append(document.createTextNode(e.name || `Unnamed ${cfg.one}`));
          li.append(top);
          const sub = cfg.subtitle === 'preview' ? e.preview : e.short;
          if (sub) { const p = document.createElement('div'); p.className = 'ev-item-sub'; p.textContent = sub; li.append(p); }
          ul.append(li);
        }
        if (!g.items.length) {
          const none = document.createElement('li');
          none.className = 'ev-none';
          none.textContent = filter ? 'No matches' : `No ${cfg.title.toLowerCase()} here yet`;
          ul.append(none);
        }
        sec.append(ul);
        frag.append(sec);
      }
      groupsEl.replaceChildren(frag);
    }

    // ---- detail pane ----------------------------------------------------------
    const set = (el, v, force) => { if (el && (force || document.activeElement !== el)) el.value = v; };

    function fillCategories(e) {
      const opts = catsOf(kind).map((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; return o; });
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'Uncategorised';
      catSel.replaceChildren(...opts, none);
      catSel.value = e.category;
    }

    function renderAttributes(e, force) {
      const host = q('.ev-attrs');
      if (!host || (!force && host.contains(document.activeElement))) return;
      host.replaceChildren(...e.attributes.map((a, i) => {
        const row = document.createElement('div');
        row.className = 'ev-attr';
        const k = document.createElement('input');
        k.value = a.k; k.placeholder = 'Name'; k.setAttribute('aria-label', 'Attribute name');
        const v = document.createElement('input');
        v.value = a.v; v.placeholder = 'Value'; v.setAttribute('aria-label', 'Attribute value');
        const patch = () => edit({ attributes: cur().attributes.map((x, j) => (j === i ? { k: k.value, v: v.value } : x)) }, 'attr' + i);
        k.addEventListener('input', patch);
        v.addEventListener('input', patch);
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'chip-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove attribute');
        x.addEventListener('click', () => S.updateEntity(kind, sel, { attributes: cur().attributes.filter((_, j) => j !== i) }));
        row.append(k, v, x);
        return row;
      }));
    }

    function renderUsage(e) {
      const host = q('.ev-usage');
      if (!host) return;
      const groups = [];
      const scenes = S.scenesWith('tags', e.id);
      if (scenes.length) groups.push(['Scenes', scenes.map(({ scene, chapter }) => [scene.title.trim() || 'Untitled scene', () => emw.openScene(scene.id)])]);
      for (const k of ['characters', 'places', 'notes']) {
        const list = S.data[k].filter((x) => x.tags.includes(e.id));
        if (list.length) groups.push([CONFIG[k].title, list.map((x) => [x.name || `Unnamed ${CONFIG[k].one}`, () => emw.openEntity(k, x.id)])]);
      }
      if (!groups.length) { host.textContent = 'Not used anywhere yet. Apply it from a scene, character, place or note.'; host.className = 'ev-usage hint'; return; }
      host.className = 'ev-usage';
      host.replaceChildren(...groups.map(([title, items]) => {
        const box = document.createElement('div');
        const h = document.createElement('div');
        h.className = 'ev-usage-h';
        h.textContent = `${title} (${items.length})`;
        const chips = document.createElement('div');
        chips.className = 'lf-chips';
        for (const [name, run] of items) {
          const c = document.createElement('span'); c.className = 'chip';
          const b = document.createElement('button'); b.type = 'button'; b.className = 'chip-name'; b.textContent = name;
          b.addEventListener('click', run);
          c.append(b); chips.append(c);
        }
        box.append(h, chips);
        return box;
      }));
    }

    async function loadThumb(e) {
      if (!thumbImg) return;
      if (!e.hasThumb) { thumbImg.hidden = true; unpick.hidden = true; return; }
      let url = thumbs.get(e.id);
      if (url === undefined) { url = await emw.files.read('thumb-' + e.id); thumbs.set(e.id, url); }
      if (sel !== e.id) return;
      thumbImg.src = url;
      thumbImg.hidden = !url;
      unpick.hidden = !url;
    }

    function refreshFields(force) {
      const e = cur();
      if (!e) return;
      set(nameEl, e.name, force);
      nameEl.placeholder = `Unnamed ${cfg.one}`;
      fillCategories(e);
      set(shortEl, e.short, force);
      if (colorEl) colorEl.value = e.color;
      if (cfg.aliases) fields.aliases.refresh();
      if (cfg.tags) fields.tags.refresh();
      if (cfg.scenes) fields.scenes.refresh();
      if (cfg.attributes) renderAttributes(e, force);
      if (cfg.usage) renderUsage(e);
      loadThumb(e);
    }

    // ---- rich content (note body), saved to its own file ------------------------------
    let mini = null;
    function flushContent() {
      clearTimeout(saveTimer);
      if (!dirty || !contentId) return;
      dirty = false;
      const id = contentId;
      emw.files.write(id, mini.html());
      if (kind === 'notes') S.setQuiet(kind, id, { preview: mini.text().replace(/\s+/g, ' ').trim().slice(0, 120) });
    }
    function scheduleContentSave() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(flushContent, 700); }
    emw.flushHooks.push(flushContent);

    async function loadContent(e) {
      if (!cfg.content) return;
      const token = ++loadToken;
      let html = await emw.files.read(e.id);
      if (token !== loadToken) return;
      let legacy = false;
      if (!html && e.legacy) { html = `<p>${emw.esc(e.legacy)}</p>`; legacy = true; }
      contentId = e.id;
      mini.load(html);
      if (legacy) { S.setQuiet(kind, e.id, { legacy: '' }); dirty = true; flushContent(); }
    }

    function loadDetail() {
      const e = cur();
      empty.hidden = !!e;
      card.hidden = !e;
      if (!e) { contentId = null; return; }
      refreshFields(true);
      loadContent(e);
    }

    function select(id, { focusName = false } = {}) {
      flushContent();
      sel = id;
      try { localStorage.setItem(lastKey(), id || ''); } catch { /* ignore */ }
      renderList();
      loadDetail();
      if (focusName) { nameEl.focus(); nameEl.select(); }
    }

    // ---- fields that link to other things -------------------------------------------------
    const fields = {};
    if (cfg.aliases) fields.aliases = emw.chipInput(q('.ev-aliases'), { get: () => cur()?.aliases, set: (v) => S.updateEntity(kind, sel, { aliases: v }) });
    if (cfg.tags) fields.tags = emw.linkField(q('.ev-tags'), { kind: 'tags', get: () => cur()?.tags, set: (v) => S.updateEntity(kind, sel, { tags: v }) });
    if (cfg.scenes) {
      const field = S.SCENE_FIELD[kind];
      fields.scenes = emw.linkField(q('.ev-scenes'), {
        kind: 'scenes',
        get: () => (sel ? S.scenesWith(kind, sel).map((x) => x.scene.id) : []),
        set: (ids) => S.batch('change scenes', () => {
          const now = new Set(ids);
          for (const ch of S.data.chapters) for (const s of ch.scenes) {
            const has = s[field].includes(sel);
            if (now.has(s.id) && !has) S.updateScene(s.id, { [field]: [...s[field], sel] });
            else if (!now.has(s.id) && has) S.updateScene(s.id, { [field]: s[field].filter((x) => x !== sel) });
          }
        })
      });
    }
    if (cfg.content) mini = emw.mini(q('.ev-mini'), { onInput: scheduleContentSave });

    // ---- events ---------------------------------------------------------------------------------
    nameEl.addEventListener('input', () => edit({ name: nameEl.value }, 'name'));
    catSel.addEventListener('change', () => S.updateEntity(kind, sel, { category: catSel.value }));
    if (shortEl) shortEl.addEventListener('input', () => edit({ short: shortEl.value }, 'short'));
    if (colorEl) colorEl.addEventListener('input', () => edit({ color: colorEl.value }, 'color'));

    root.querySelectorAll('.ev-tabs button').forEach((tab) => tab.addEventListener('click', () => {
      root.querySelectorAll('.ev-tabs button').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      root.querySelectorAll('.ev-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    }));
    q('.ev-attr-add')?.addEventListener('click', () => S.updateEntity(kind, sel, { attributes: [...cur().attributes, { k: '', v: '' }] }));

    if (cfg.thumb) {
      const file = q('.ev-file');
      q('.ev-pick').addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files[0];
        file.value = '';
        if (!f) return;
        try {
          const url = await emw.imageToDataUrl(f, 320);
          const id = sel;
          thumbs.set(id, url);
          await emw.files.write('thumb-' + id, url);
          S.updateEntity(kind, id, { hasThumb: true });
          loadThumb(S.entity(kind, id));
        } catch (err) { emw.toast(err.message); }
      });
      unpick.addEventListener('click', () => S.updateEntity(kind, sel, { hasThumb: false }));
    }

    function deleteItem(id) {
      const e = S.entity(kind, id);
      if (!e) return;
      const list = S.data[kind];
      const i = list.indexOf(e);
      const name = e.name || `Unnamed ${cfg.one}`;
      flushContent();
      S.deleteEntity(kind, e.id);
      if (id === sel) select((list[Math.min(i, list.length - 1)] || {}).id || null);   // deleting another row leaves the selection alone
      emw.toast(`Deleted “${name}”`, { action: { label: 'Undo', run: () => { S.undo(); } } });
    }
    async function duplicateItem(id) {
      const e = S.entity(kind, id);
      if (!e) return;
      flushContent();
      const copy = S.duplicateEntity(kind, e.id);
      const [html, thumb] = await Promise.all([emw.files.read(e.id), e.hasThumb ? emw.files.read('thumb-' + e.id) : '']);
      if (html) await emw.files.write(copy, html);
      if (thumb) await emw.files.write('thumb-' + copy, thumb);
      select(copy, { focusName: true });
    }
    q('.ev-delete').addEventListener('click', () => { if (sel) deleteItem(sel); });
    q('.ev-dup').addEventListener('click', () => { if (sel) duplicateItem(sel); });
    // Sending flushes a note's pending body first (emw.darlings does it), and the store change
    // makes onStore move the selection if the open item left.
    const sendItem = (id) => emw.darlings.send(cfg.one, id, { origin: kind });
    function itemMenu(id, x, y) {
      emw.menu(x, y, [
        { label: 'Rename', run: () => { if (id !== sel) select(id); nameEl.focus(); nameEl.select(); } },
        { label: 'Duplicate', run: () => duplicateItem(id) },
        { label: 'Send to Darlings', run: () => sendItem(id) },
        null,
        { label: 'Delete', danger: true, run: () => deleteItem(id) }
      ]);
    }

    q('.ev-new').addEventListener('click', () => newItem());
    function newItem(catId) {
      const e = cur();
      const id = S.addEntity(kind, { category: catId ?? e?.category ?? catsOf(kind)[0]?.id ?? '' });
      select(id, { focusName: true });
    }
    q('.ev-filter').addEventListener('input', (e) => { filter = e.target.value.trim().toLowerCase(); renderList(); });
    q('.ev-newcat').addEventListener('click', () => {
      const id = S.addCategory(kind, 'New category');
      renderList();
      renameCategory(id);
    });

    function renameCategory(id) {
      const h = groupsEl.querySelector(`.ev-group[data-cat="${id}"] .ev-cat-name`);
      const c = catsOf(kind).find((x) => x.id === id);
      if (!h || !c) return;
      emw.rename(h, { value: c.name, placeholder: 'Category name', onCommit: (v) => { if (v) S.renameCategory(kind, id, v); }, onDone: renderList });
    }
    function categoryMenu(id, x, y) {
      const list = catsOf(kind);
      const i = list.findIndex((c) => c.id === id);
      emw.menu(x, y, [
        { label: 'Rename category', run: () => renameCategory(id) },
        { label: `Add ${cfg.one} here`, run: () => newItem(id) },
        null,
        { label: 'Move up', disabled: i === 0, run: () => S.moveCategory(kind, id, i - 1) },
        { label: 'Move down', disabled: i === list.length - 1, run: () => S.moveCategory(kind, id, i + 2) },
        null,
        { label: 'Send to Darlings', run: () => emw.darlings.send('category', id, { origin: kind, entityKind: kind }) },
        { label: 'Delete category', danger: true, run: () => {
          const name = list[i].name;
          S.deleteCategory(kind, id);
          emw.toast(`Deleted category “${name}”. Its ${cfg.title.toLowerCase()} are now uncategorised.`, { action: { label: 'Undo', run: () => { S.undo(); } } });
        } }
      ]);
    }

    groupsEl.addEventListener('click', (e) => {
      if (e.target.closest('.rename')) return;
      const k = e.target.closest('.kebab');
      if (k) { const r = k.getBoundingClientRect(); categoryMenu(k.closest('.ev-group').dataset.cat, r.left, r.bottom); return; }
      const li = e.target.closest('.ev-item');
      if (li && li.dataset.id !== sel) select(li.dataset.id);
    });
    groupsEl.addEventListener('dblclick', (e) => {
      const nm = e.target.closest('.ev-cat-name');
      if (nm) { const id = nm.closest('.ev-group').dataset.cat; if (id) renameCategory(id); }
    });
    groupsEl.addEventListener('contextmenu', (e) => {
      const g = e.target.closest('.ev-group');
      if (g && g.dataset.cat && e.target.closest('.ev-cat')) { e.preventDefault(); categoryMenu(g.dataset.cat, e.clientX, e.clientY); return; }
      const li = e.target.closest('.ev-item');
      if (li) { e.preventDefault(); itemMenu(li.dataset.id, e.clientX, e.clientY); }
    });

    // Drag an item onto a category heading to move it there.
    let dragId = null;
    const clearMarks = () => groupsEl.querySelectorAll('.drop-over').forEach((n) => n.classList.remove('drop-over'));
    groupsEl.addEventListener('dragstart', (e) => {
      const li = e.target.closest?.('.ev-item');
      if (!li) return;
      dragId = li.dataset.id;
      emw.dragItem = { kind: cfg.one, id: dragId, origin: kind };   // so the Darlings tab can take it
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    groupsEl.addEventListener('dragover', (e) => { if (!dragId) return; const g = e.target.closest('.ev-group'); clearMarks(); if (g) { e.preventDefault(); g.classList.add('drop-over'); } });
    groupsEl.addEventListener('drop', (e) => {
      const g = e.target.closest('.ev-group');
      clearMarks();
      if (!dragId || !g) return;
      e.preventDefault();
      S.updateEntity(kind, dragId, { category: g.dataset.cat });
    });
    groupsEl.addEventListener('dragend', () => { dragId = null; emw.dragItem = null; clearMarks(); });

    // ---- keeping up with the store ----------------------------------------------------------------
    let stale = true;
    function onStore() {
      if (root.hidden) { stale = true; return; }
      if (sel && !cur()) { flushContent(); sel = S.data[kind][0]?.id || null; loadDetail(); }
      renderList();
      refreshFields(false);
    }
    S.on(onStore);
    emw.onView((name) => {
      if (name !== kind) { flushContent(); return; }
      if (!sel || !cur()) { let last = ''; try { last = localStorage.getItem(lastKey()) || ''; } catch { /* ignore */ } sel = S.entity(kind, last) ? last : (S.data[kind][0]?.id || null); }
      stale = false;
      renderList();
      loadDetail();
    });

    // A different book: forget the selection, filter, cached thumbnails and the open note body.
    // The views are hidden during a switch, so the next time one is shown it picks from the new data.
    emw.book.onSwitch(() => {
      loadToken++;
      clearTimeout(saveTimer);
      dirty = false;
      contentId = null;
      sel = null;
      filter = '';
      q('.ev-filter').value = '';
      thumbs.clear();
      if (mini) mini.load('');
      stale = true;
    });

    return { select, newItem };
  }

  for (const kind of S.KINDS) views[kind] = createView(kind);

  emw.openEntity = (kind, id) => { emw.showView(kind); views[kind].select(id); };
})();
