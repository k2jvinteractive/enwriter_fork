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
      b.className = 'menu-item' + (it.danger ? ' danger-item' : '');
      b.disabled = !!it.disabled;
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label;
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
      ['New chapter', 'Ctrl+N', 'newChapter'],
      ['New scene', 'Ctrl+Shift+N', 'newScene'],
      ['Save', 'Ctrl+S', 'save'],
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
      ['Send to Darlings', 'Ctrl+Shift+D', 'sendToDarlings'],
      null,
      ['Select all', 'Ctrl+A', 'selectAll']
    ]],
    ['View', [
      ['Pin chapters panel', 'Alt+1', 'toggleHierarchy'],
      ['Show ribbon', 'Alt+2', 'toggleRibbon'],
      ['Pin inspector', 'Alt+3', 'toggleInspector']
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
  const TITLES = {
    home: 'Home', places: 'Places', characters: 'Characters', timeline: 'Timeline',
    manuscript: 'Manuscript', darlings: 'Darlings', notes: 'Notes', tags: 'Tags'
  };
  const BUILT = ['manuscript', 'timeline', 'characters', 'places', 'notes', 'tags', 'darlings'];
  let currentView = 'manuscript';
  const tabs = $$('.tab[data-view]');

  function showView(name) {
    currentView = name;
    const built = BUILT.includes(name);
    for (const v of BUILT) $('#view-' + v).hidden = v !== name;
    $('#blank').hidden = built;
    $('#stats').hidden = !built;   // each view decides which of its parts show (see darlings.js)
    $('#blank-title').textContent = TITLES[name];
    tabs.forEach((t) => t.setAttribute('aria-current', String(t.dataset.view === name)));
    emw.viewListeners.forEach((cb) => cb(name));
    if (name === 'manuscript') emw.editor?.focus();
  }
  emw.showView = showView;
  tabs.forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  showView('manuscript');
})();
