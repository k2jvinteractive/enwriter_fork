// Menu bar, panel toggles, bottom tabs and the shared dialog.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // Shared namespace for the three scripts.
  const emw = (window.emw = { actions: {}, view: () => currentView });

  // ---- Dialog (Electron has no prompt/confirm that behaves well) ----------
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

  // ---- Menu bar ------------------------------------------------------------
  const isMac = /Mac/.test(navigator.platform);
  const keyLabel = (k) => (isMac ? k.replace('Ctrl', '⌘').replace('Alt', '⌥') : k);
  const MENUS = [
    ['File', [
      ['New chapter', 'Ctrl+N', 'newChapter'],
      ['Save', 'Ctrl+S', 'save'],
      null,
      ['Delete chapter', '', 'deleteChapter']
    ]],
    ['Edit', [
      ['Undo', 'Ctrl+Z', 'undo'],
      ['Redo', 'Ctrl+Shift+Z', 'redo'],
      null,
      ['Select all', 'Ctrl+A', 'selectAll']
    ]],
    ['View', [
      ['Chapters', 'Alt+1', 'toggleHierarchy'],
      ['Ribbon', 'Alt+2', 'toggleRibbon'],
      ['Inspector', 'Alt+3', 'toggleInspector']
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
      if (!item) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        list.append(sep);
        continue;
      }
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
  window.addEventListener('blur', closeMenus);

  // ---- Panel toggles (remembered between launches) -------------------------
  const KEY = 'emwriter.ui';
  let ui = { hierarchy: true, ribbon: true, inspector: true };
  try { Object.assign(ui, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* first run */ }

  const panels = { hierarchy: $('#hierarchy'), ribbon: $('#ribbon'), inspector: $('#inspector') };
  function applyPanels() {
    for (const name of Object.keys(panels)) panels[name].hidden = !ui[name];
    $$('[data-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(ui[b.dataset.toggle])));
  }
  function toggle(name) {
    ui[name] = !ui[name];
    applyPanels();
    try { localStorage.setItem(KEY, JSON.stringify(ui)); } catch { /* ignore */ }
  }
  emw.actions.toggleHierarchy = () => toggle('hierarchy');
  emw.actions.toggleRibbon = () => toggle('ribbon');
  emw.actions.toggleInspector = () => toggle('inspector');
  $$('[data-toggle]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.toggle)));
  applyPanels();

  // ---- Bottom tabs ---------------------------------------------------------
  const TITLES = {
    home: 'Home', places: 'Places', characters: 'Characters', timeline: 'Timeline',
    manuscript: 'Manuscript', darlings: 'Darlings', notes: 'Notes', tags: 'Tags'
  };
  let currentView = 'manuscript';
  const tabs = $$('.tab[data-view]');

  function showView(name) {
    currentView = name;
    const manuscript = name === 'manuscript';
    $('#view-manuscript').hidden = !manuscript;
    $('#blank').hidden = manuscript;
    $('#stats').hidden = !manuscript;
    $('#blank-title').textContent = TITLES[name];
    tabs.forEach((t) => t.setAttribute('aria-current', String(t.dataset.view === name)));
    if (manuscript) emw.editor?.focus();
  }
  tabs.forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  showView('manuscript');
})();
