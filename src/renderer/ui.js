// Menu bar, auto-hiding panels, bottom tabs, and shared widgets
// (dialog, context menu, toast, inline rename).
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const emw = (window.emw = { actions: {}, view: () => currentView, viewListeners: [] });
  emw.onView = (cb) => emw.viewListeners.push(cb);
  emw.flushHooks = [];   // functions that save pending work before the app closes
  emw.isTextField = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  // ---- Prompt dialog (Electron's prompt/confirm misbehave) ------------------
  const dlg = $('#dialog');
  const msg = $('#dialog-message');
  const input = $('#dialog-input');
  const okBtn = $('#dialog-ok');
  let resolver = null;
  let wantsInput = false;

  emw.ask = ({ message, input: initial, okLabel = 'OK', danger = false }) =>
    new Promise((resolve) => {
      resolver = resolve;
      wantsInput = initial !== undefined;
      msg.textContent = message;
      input.hidden = !wantsInput;
      input.value = wantsInput ? initial : '';
      okBtn.textContent = okLabel;
      okBtn.classList.toggle('danger', danger);
      dlg.returnValue = '';
      dlg.showModal();
      if (wantsInput) { input.focus(); input.select(); }
    });
  $('#dialog-cancel').addEventListener('click', () => dlg.close('cancel'));
  dlg.addEventListener('close', () => {
    const ok = dlg.returnValue === 'ok';
    if (resolver) resolver(wantsInput ? (ok ? input.value : null) : ok);
    resolver = null;
  });

  // ---- Toast with optional action (used for "Undo") ---------------------------
  const toastEl = $('#toast');
  let toastTimer = 0;
  // `action` is one button; `actions` is a list (a toast can offer Undo and a second step).
  emw.toast = (message, { action, actions, ms = 5000 } = {}) => {
    const text = document.createElement('span');
    text.textContent = message;
    toastEl.replaceChildren(text);
    for (const a of actions || (action ? [action] : [])) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', () => { toastEl.hidden = true; a.run(); });
      toastEl.append(b);
    }
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  };

  // ---- Context menu ------------------------------------------------------------
  let ctx = null;
  const closeCtx = () => { if (ctx) { ctx.remove(); ctx = null; } };
  emw.menu = (x, y, items) => {
    closeCtx();
    ctx = document.createElement('div');
    ctx.className = 'menu-list ctx';
    ctx.setAttribute('role', 'menu');
    for (const it of items) {
      if (!it) { const s = document.createElement('div'); s.className = 'menu-sep'; ctx.append(s); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item' + (it.danger ? ' danger-item' : '') + (it.strong ? ' menu-strong' : '');
      b.disabled = !!it.disabled;
      if (it.dot) {
        // Part 7j2: a relationship type, shown as its colour and read in direction. The dot is only a
        // second way to tell the kinds apart, so it is hidden from the screen reader.
        b.setAttribute('role', 'menuitem');
        const row = document.createElement('span');
        row.className = 'menu-choice';
        const d = document.createElement('i');
        d.className = 'menu-dot';
        d.setAttribute('aria-hidden', 'true');
        d.style.setProperty('--rc', it.dot);
        row.append(d, it.label);
        b.append(row);
      } else if (typeof it.checked === 'boolean') {
        // A choice from a set (part 7c): a check mark in front of the current one.
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(it.checked));
        const row = document.createElement('span');
        row.className = 'menu-choice';
        const mark = document.createElement('span');
        mark.className = 'menu-check';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = it.checked ? '✓' : '';
        row.append(mark, it.label);
        b.append(row);
      } else {
        b.setAttribute('role', 'menuitem');
        b.textContent = it.label;
      }
      b.addEventListener('click', () => { closeCtx(); it.run(); });
      ctx.append(b);
    }
    document.body.append(ctx);
    const r = ctx.getBoundingClientRect();
    ctx.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 8)) + 'px';
    ctx.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 8)) + 'px';
    ctx.querySelector('button:not(:disabled)')?.focus();
  };
  document.addEventListener('mousedown', (e) => { if (ctx && !ctx.contains(e.target)) closeCtx(); }, true);
  window.addEventListener('blur', closeCtx);
  document.addEventListener('scroll', closeCtx, true);

  // ---- Inline rename: swaps an element for a text box --------------------------
  emw.rename = (target, { value, placeholder = '', onCommit, onDone }) => {
    const host = target.closest('[draggable="true"]');
    if (host) host.draggable = false;   // otherwise the mouse can't select text in the box
    const box = document.createElement('input');
    box.className = 'rename';
    box.value = value;
    box.placeholder = placeholder;
    box.maxLength = 120;
    box.spellcheck = false;
    target.replaceWith(box);
    box.focus();
    box.select();
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      if (host) host.draggable = true;
      if (ok) onCommit(box.value.trim());
      if (onDone) onDone();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    box.addEventListener('blur', () => finish(true));
  };

  // ---- Menu bar -----------------------------------------------------------------
  const isMac = /Mac/.test(navigator.platform);
  const keyLabel = (k) => (isMac ? k.replace('Ctrl', '⌘').replace('Alt', '⌥') : k);
  const MENUS = [
    ['File', [
      ['New book (on Home)', 'Ctrl+N', 'newBook'],
      ['New chapter', 'Ctrl+N', 'newChapter'],
      ['New scene', 'Ctrl+Shift+N', 'newScene'],
      ['Save and snapshot', 'Ctrl+S', 'save'],
      ['Save snapshot with a name…', 'Ctrl+Shift+S', 'saveSnapshotAs'],
      null,
      ['Settings…', 'Ctrl+,', 'openSettings'],
      null,
      ['Delete current chapter or scene', '', 'deleteCurrent']
    ]],
    ['Edit', [
      ['Undo', 'Ctrl+Z', 'undo'],
      ['Redo', 'Ctrl+Shift+Z', 'redo'],
      null,
      ['Undo chapter or scene change', 'Ctrl+Alt+Z', 'undoStructure'],
      ['Redo chapter or scene change', 'Ctrl+Alt+Shift+Z', 'redoStructure'],
      null,
      ['Find…', 'Ctrl+F', 'find'],
      ['Find next', 'F3', 'findNext'],
      ['Find previous', 'Shift+F3', 'findPrevious'],
      ['Replace…', 'Ctrl+H', 'replace'],
      null,
      ['Send to Darlings', 'Ctrl+Shift+D', 'sendToDarlings'],
      null,
      ['Select all', 'Ctrl+A', 'selectAll'],
      null,
      ['Spell check', 'F7', 'toggleSpellcheck']
    ]],
    ['View', [
      ['Home', '', 'goHome'],
      ['Manuscript', '', 'goManuscript'],
      ['Timeline', '', 'goTimeline'],
      ['Characters', '', 'goCharacters'],
      ['Family trees', '', 'openFamilyTrees'],
      ['Places', '', 'goPlaces'],
      ['Darlings', '', 'goDarlings'],
      ['Notes', '', 'goNotes'],
      ['Tags', '', 'goTags'],
      ['Customise bottom bar…', '', 'customiseBottomBar'],
      null,
      ['Pin chapters panel', 'Alt+1', 'toggleHierarchy'],
      ['Show ribbon', 'Alt+2', 'toggleRibbon'],
      ['Pin inspector', 'Alt+3', 'toggleInspector']
    ]],
    ['Help', [
      ['Keyboard shortcuts…', 'Ctrl+/', 'openShortcuts']
    ]]
  ];

  const bar = $('#menus');
  for (const [name, items] of MENUS) {
    const wrap = document.createElement('div');
    wrap.className = 'menu';
    const btn = document.createElement('button');
    btn.className = 'menu-btn';
    btn.type = 'button';
    btn.textContent = name;
    btn.setAttribute('aria-haspopup', 'true');
    const list = document.createElement('div');
    list.className = 'menu-list';
    list.setAttribute('role', 'menu');
    for (const item of items) {
      if (!item) { const s = document.createElement('div'); s.className = 'menu-sep'; list.append(s); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item';
      b.dataset.action = item[2];
      b.setAttribute('role', 'menuitem');
      const label = document.createElement('span');
      label.textContent = item[0];
      const keys = document.createElement('span');
      keys.className = 'keys';
      keys.textContent = keyLabel(item[1]);
      b.append(label, keys);
      list.append(b);
    }
    wrap.append(btn, list);
    bar.append(wrap);
  }

  // The labels above are only a fallback. Once shortcuts.js knows an action, the label shows its
  // effective binding, so a rebound key is reflected here (and an action with no key shows none).
  emw.refreshMenuKeys = () => {
    for (const b of $$('.menu-item[data-action]', bar)) {
      const id = b.dataset.action;
      if (!emw.keys || !emw.keys.has(id)) continue;
      b.querySelector('.keys').textContent = emw.keys.display(id);
      b.hidden = emw.keys.isHidden(id);   // secret actions stay out of the menus until bound
    }
  };

  const closeMenus = () => $$('.menu.open', bar).forEach((m) => m.classList.remove('open'));
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('.menu-item')) e.preventDefault(); });
  bar.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (item) { closeMenus(); emw.actions[item.dataset.action]?.(); return; }
    const btn = e.target.closest('.menu-btn');
    if (btn) {
      const menu = btn.parentElement;
      const wasOpen = menu.classList.contains('open');
      closeMenus();
      if (!wasOpen) menu.classList.add('open');
    }
  });
  bar.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('.menu-btn');
    if (btn && $('.menu.open', bar) && !btn.parentElement.classList.contains('open')) {
      closeMenus();
      btn.parentElement.classList.add('open');
    }
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenus(); closeCtx(); } });
  window.addEventListener('blur', closeMenus);

  // ---- Panels: auto-hide by default, pin to keep them open ------------------------
  const KEY = 'emwriter.ui2';
  const ui = { ribbon: true, pin: { hierarchy: false, inspector: false } };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (typeof saved.ribbon === 'boolean') ui.ribbon = saved.ribbon;
    Object.assign(ui.pin, saved.pin || {});
  } catch { /* first run */ }

  const SIDES = ['hierarchy', 'inspector'];
  const panels = { hierarchy: $('#hierarchy'), inspector: $('#inspector') };
  const edges = { hierarchy: $('#edge-left'), inspector: $('#edge-right') };
  const closeTimers = {};

  const setOpen = (name, open) => panels[name].classList.toggle('open', open);
  function scheduleClose(name) {
    if (ui.pin[name]) return;
    clearTimeout(closeTimers[name]);
    closeTimers[name] = setTimeout(() => {
      const p = panels[name];
      if (p.matches(':hover') || (p.contains(document.activeElement) && emw.isTextField(document.activeElement))) return;
      setOpen(name, false);
    }, 300);
  }
  emw.peek = (name) => { clearTimeout(closeTimers[name]); if (!ui.pin[name]) setOpen(name, true); };

  function applyPanels() {
    for (const name of SIDES) {
      panels[name].classList.toggle('float', !ui.pin[name]);
      panels[name].classList.remove('open');
      edges[name].hidden = ui.pin[name];
    }
    $('#ribbon').hidden = !ui.ribbon;
    $$('[data-toggle]').forEach((b) => {
      const n = b.dataset.toggle;
      b.setAttribute('aria-pressed', String(n === 'ribbon' ? ui.ribbon : ui.pin[n]));
    });
  }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(ui)); } catch { /* ignore */ } }
  function toggle(name) {
    if (name === 'ribbon') ui.ribbon = !ui.ribbon; else ui.pin[name] = !ui.pin[name];
    applyPanels();
    persist();
  }
  for (const name of SIDES) {
    edges[name].addEventListener('mouseenter', () => emw.peek(name));
    panels[name].addEventListener('mouseenter', () => clearTimeout(closeTimers[name]));
    panels[name].addEventListener('mouseleave', () => scheduleClose(name));
    panels[name].addEventListener('focusout', () => scheduleClose(name));
  }
  document.addEventListener('mousedown', (e) => {
    for (const name of SIDES) {
      if (!ui.pin[name] && panels[name].classList.contains('open') &&
          !panels[name].contains(e.target) && !edges[name].contains(e.target)) setOpen(name, false);
    }
  });
  emw.actions.toggleHierarchy = () => toggle('hierarchy');
  emw.actions.toggleRibbon = () => toggle('ribbon');
  emw.actions.toggleInspector = () => toggle('inspector');
  $$('[data-toggle]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.toggle)));
  applyPanels();

  // ---- Bottom tabs -----------------------------------------------------------------
  // TABS is the single source of truth for the bar. Order and visibility come from
  // settings.tabs; the buttons themselves are created once and only moved or detached, so other
  // files (darlings.js makes the Darlings tab a drop target) keep working on the same elements.
  const TABS = [
    { id: 'home', label: 'Home', hideable: false },
    { id: 'places', label: 'Places', hideable: true },
    { id: 'characters', label: 'Characters', hideable: true },
    { id: 'timeline', label: 'Timeline', hideable: true },
    { id: 'manuscript', label: 'Manuscript', hideable: false },
    { id: 'darlings', label: 'Darlings', hideable: true },
    { id: 'notes', label: 'Notes', hideable: true },
    { id: 'tags', label: 'Tags', hideable: true }
  ];
  const TITLES = Object.fromEntries(TABS.map((t) => [t.id, t.label]));
  const BUILT = ['home', 'manuscript', 'timeline', 'characters', 'places', 'notes', 'tags', 'darlings'];
  let currentView = 'home';
  const hasBook = () => !!(emw.book && emw.book.id);

  // Turns whatever was saved into a complete, safe layout: unknown ids are dropped, duplicates
  // collapse, ids missing from `order` are appended (so tabs added in a later version appear on
  // their own), and tabs that cannot be hidden never are.
  function normaliseTabs(cfg) {
    const known = new Set(TABS.map((t) => t.id));
    const order = [];
    for (const id of (cfg && Array.isArray(cfg.order) ? cfg.order : [])) if (known.has(id) && !order.includes(id)) order.push(id);
    for (const t of TABS) if (!order.includes(t.id)) order.push(t.id);
    const locked = new Set(TABS.filter((t) => !t.hideable).map((t) => t.id));
    const hidden = [];
    for (const id of (cfg && Array.isArray(cfg.hidden) ? cfg.hidden : [])) if (known.has(id) && !locked.has(id) && !hidden.includes(id)) hidden.push(id);
    return { order, hidden };
  }

  const tabbarEl = $('.tabbar');
  const leftSlot = $('.tabbar-left');
  const tabsNav = $('.tabs');
  const tabEl = {};   // id -> the one button for that tab
  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.type = 'button';
    b.dataset.view = t.id;
    b.textContent = t.label;
    b.addEventListener('click', () => { if (b.getAttribute('aria-disabled') !== 'true') showView(t.id); });
    tabEl[t.id] = b;
  }

  // Lays the bar out from a config. Home keeps its place in the side column while it is first
  // and the word count is on the right; otherwise it joins the other tabs. Hidden tabs are
  // detached from the bar, not just hidden, so the grid and tab order never see them.
  function applyTabs(cfg, statsSide) {
    const { order, hidden } = normaliseTabs(cfg);
    const side = statsSide === 'left' ? 'left' : 'right';
    tabbarEl.dataset.stats = side;
    const shown = order.filter((id) => !hidden.includes(id));
    const homeInSide = side === 'right' && shown[0] === 'home';
    leftSlot.replaceChildren(...(homeInSide ? [tabEl.home] : []));
    leftSlot.hidden = !homeInSide;
    tabsNav.replaceChildren(...shown.filter((id) => !(homeInSide && id === 'home')).map((id) => tabEl[id]));
    refreshTabs();
    for (const id in tabEl) tabEl[id].setAttribute('aria-current', String(id === currentView));
    keepCurrentInView();
  }

  // In a narrow window all eight tabs may not fit in the middle column. The bar then scrolls
  // sideways (mouse wheel works too) and the tab you are on is always brought into view.
  function keepCurrentInView() {
    const t = tabEl[currentView];
    if (!t || t.parentElement !== tabsNav || tabsNav.scrollWidth <= tabsNav.clientWidth) return;
    const box = tabsNav.getBoundingClientRect(), r = t.getBoundingClientRect();
    if (r.left < box.left) tabsNav.scrollLeft -= box.left - r.left;
    else if (r.right > box.right) tabsNav.scrollLeft += r.right - box.right;
  }
  tabsNav.addEventListener('wheel', (e) => {
    if (tabsNav.scrollWidth <= tabsNav.clientWidth || !e.deltaY || e.deltaX) return;
    e.preventDefault();
    tabsNav.scrollLeft += e.deltaY;
  }, { passive: false });
  window.addEventListener('resize', keepCurrentInView);

  // With no book open only Home works; the other tabs are muted and ignore clicks.
  function refreshTabs() {
    for (const id in tabEl) {
      if (id === 'home') continue;
      if (hasBook()) tabEl[id].removeAttribute('aria-disabled'); else tabEl[id].setAttribute('aria-disabled', 'true');
    }
    $('#stats').hidden = currentView === 'home' || !hasBook();
  }
  emw.refreshTabs = refreshTabs;

  function showView(name) {
    if (name !== 'home' && !hasBook()) return;   // nothing to show without a book
    currentView = name;
    const built = BUILT.includes(name);
    for (const v of BUILT) $('#view-' + v).hidden = v !== name;
    $('#blank').hidden = built;
    $('#stats').hidden = !built || name === 'home';   // each view decides which of its parts show (see darlings.js)
    $('#blank-title').textContent = TITLES[name];
    for (const id in tabEl) tabEl[id].setAttribute('aria-current', String(id === name));
    keepCurrentInView();
    emw.viewListeners.forEach((cb) => cb(name));
    if (name === 'manuscript') emw.editor?.focus();
  }
  emw.showView = showView;
  emw.tabbar = { TABS, normalise: normaliseTabs, apply: applyTabs };
  emw.actions.goHome = () => showView('home');
  // A tab hidden from the bar is still one menu click away (View menu).
  for (const t of TABS) if (t.id !== 'home') emw.actions['go' + t.label] = () => showView(t.id);

  // First paint uses what boot.js read from settings.json; settings.js keeps it live afterwards.
  let saved = {};
  try { saved = (window.emwPrefs && window.emwPrefs.current()) || {}; } catch { /* defaults */ }
  applyTabs(saved.tabs, saved.statsSide);
  showView('home');
})();
