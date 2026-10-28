// Settings: live-applied preferences saved to settings.json in the main process.
// Sections are pluggable (emw.settings.addSection) so parts 5d and 5e add theirs without
// touching this file. There is no OK or Cancel: every change applies at once and saves ~300 ms later.
(() => {
  'use strict';
  const emw = window.emw;
  const P = window.emwPrefs;

  // Mirrors DEFAULTS in library.js (main). Saved values are merged over this.
  const DEFAULTS = { penName: '', theme: 'dark', accent: '#e8caa4', uiScale: 100, reduceMotion: null };

  const ACCENTS = [
    ['Sand', '#e8caa4'], ['Amber', '#e5b567'], ['Coral', '#e58f72'], ['Rose', '#e39aa6'],
    ['Sage', '#a9c8a0'], ['Teal', '#8dd0c4'], ['Sky', '#8fb8e6'], ['Lavender', '#bba9e6']
  ];

  let values = { ...DEFAULTS, ...(P ? P.current() : {}) };
  const listeners = [];
  const pending = {};
  let timer = 0;

  // ---- saving ----------------------------------------------------------------------------
  async function flush() {
    clearTimeout(timer);
    const keys = Object.keys(pending);
    for (const k of keys) {
      const v = pending[k];
      delete pending[k];
      try { await window.api.setSetting(k, v); }
      catch { emw.toast('Could not save that setting. It will reset next time you start.'); }
    }
  }

  function set(key, value) {
    values[key] = value;
    if (P) P.apply({ [key]: value });
    pending[key] = value;
    clearTimeout(timer);
    timer = setTimeout(flush, 300);
    listeners.forEach((cb) => { try { cb(key, value); } catch { /* a listener must not break saving */ } });
  }

  function reset(keys) { keys.forEach((k) => set(k, DEFAULTS[k])); }

  emw.flushHooks.push(flush);

  emw.settings = {
    DEFAULTS,
    get: (key) => values[key],
    set,
    reset,
    onChange: (cb) => listeners.push(cb),
    updateAccentInk: P ? P.updateAccentInk : () => {},
    addSection: (s) => { sections.push(s); if (nav) buildNav(); },
    open: () => open(),
    flush
  };

  // ---- small DOM helpers -----------------------------------------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const row = (label, control, hint) => {
    const r = el('div', 'st-row');
    r.append(el('span', 'lbl', label), control);
    if (hint) r.append(el('span', 'st-hint', hint));
    return r;
  };

  function segmented(name, options, current, onPick) {
    const g = el('div', 'st-seg');
    g.setAttribute('role', 'radiogroup');
    for (const [label, val] of options) {
      const l = el('label');
      const i = el('input');
      i.type = 'radio';
      i.name = name;
      i.checked = String(val) === String(current);
      i.addEventListener('change', () => onPick(val));
      l.append(i, el('span', null, label));
      g.append(l);
    }
    return g;
  }

  function resetLink(keys, rerender) {
    const b = el('button', 'st-reset', 'Reset to default');
    b.type = 'button';
    b.addEventListener('click', () => { reset(keys); rerender(); });
    return b;
  }

  // ---- built-in sections -----------------------------------------------------------------
  const sections = [
    {
      id: 'profile', label: 'Profile',
      render(pane, redo) {
        pane.append(el('h2', null, 'Profile'));
        const input = el('input');
        input.type = 'text';
        input.maxLength = 100;
        input.value = values.penName;
        input.placeholder = 'Your name as readers see it';
        input.setAttribute('aria-label', 'Pen name');
        input.addEventListener('input', () => set('penName', input.value.trim()));
        pane.append(row('Pen name', input, 'Shown on Home and as the author line on book covers. You can leave it empty.'));
        pane.append(resetLink(['penName'], redo));
      }
    },
    {
      id: 'appearance', label: 'Appearance',
      render(pane, redo) {
        pane.append(el('h2', null, 'Appearance'));

        pane.append(row('Theme', segmented('st-theme',
          [['Dark', 'dark'], ['Light', 'light'], ['Match system', 'system']], values.theme, (v) => set('theme', v))));

        const sw = el('div', 'st-swatches');
        const swatches = [];
        const mark = () => swatches.forEach(([b, hex]) => b.setAttribute('aria-pressed', String(hex.toLowerCase() === values.accent.toLowerCase())));
        const custom = el('input');
        custom.type = 'color';
        custom.value = values.accent;
        custom.setAttribute('aria-label', 'Custom accent colour');
        for (const [name, hex] of ACCENTS) {
          const b = el('button', 'st-sw');
          b.type = 'button';
          b.title = name;
          b.setAttribute('aria-label', name + ' accent');
          b.style.background = hex;
          b.addEventListener('click', () => { set('accent', hex); custom.value = hex; mark(); });
          swatches.push([b, hex]);
          sw.append(b);
        }
        custom.addEventListener('input', () => { set('accent', custom.value); mark(); });
        sw.append(custom);
        mark();
        pane.append(row('Accent colour', sw));

        pane.append(row('Interface size', segmented('st-scale',
          [['90%', 90], ['100%', 100], ['110%', 110], ['125%', 125]], values.uiScale, (v) => set('uiScale', Number(v)))));

        const label = el('label', 'st-check');
        const cb = el('input');
        cb.type = 'checkbox';
        // Shows what is in effect: the saved choice, or the OS setting when none was made.
        cb.checked = values.reduceMotion === null ? (P ? P.osReducedMotion() : false) : values.reduceMotion;
        cb.addEventListener('change', () => set('reduceMotion', cb.checked));
        label.append(cb, el('span', null, 'Reduce motion'));
        pane.append(row('Motion', label, 'Turns off animations and transitions. Follows your system until you change it.'));

        pane.append(resetLink(['theme', 'accent', 'uiScale', 'reduceMotion'], redo));
      }
    }
  ];

  // ---- the dialog ------------------------------------------------------------------------
  let dlg = null, nav = null, pane = null, activeId = 'profile';

  function showSection(id) {
    const s = sections.find((x) => x.id === id) || sections[0];
    activeId = s.id;
    nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === activeId)));
    pane.textContent = '';
    s.render(pane, () => showSection(activeId));
  }

  function buildNav() {
    nav.textContent = '';
    for (const s of sections) {
      const b = el('button', null, s.label);
      b.type = 'button';
      b.dataset.id = s.id;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => showSection(s.id));
      nav.append(b);
    }
    nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === activeId)));
  }

  function build() {
    dlg = el('dialog', 'big');
    dlg.id = 'settings-dialog';
    dlg.setAttribute('aria-label', 'Settings');
    const body = el('div', 'st-body');
    nav = el('nav', 'st-nav');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-orientation', 'vertical');
    nav.setAttribute('aria-label', 'Settings sections');
    pane = el('section', 'st-pane');
    body.append(nav, pane);
    const foot = el('footer', 'sd-foot');
    foot.style.justifyContent = 'flex-end';
    const close = el('button', 'primary', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => dlg.close());
    foot.append(close);
    dlg.append(body, foot);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    // Save right away when the dialog closes rather than waiting out the debounce.
    dlg.addEventListener('close', flush);
    // Arrow keys move through the section list.
    nav.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const bs = [...nav.querySelectorAll('button')];
      const i = bs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const n = bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length];
      n.focus();
      showSection(n.dataset.id);
    });
    document.body.append(dlg);
    buildNav();
  }

  function open(sectionId) {
    if (!dlg) build();
    if (dlg.open) return;
    showSection(sectionId || activeId);
    dlg.showModal();
    (nav.querySelector('[aria-selected="true"]') || nav.firstChild).focus();
  }

  // ---- entry points ----------------------------------------------------------------------
  emw.actions.openSettings = () => { if (dlg && dlg.open) dlg.close(); else open(); };

  const gear = document.getElementById('open-settings');
  if (gear) gear.addEventListener('click', () => emw.actions.openSettings());

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ',') {
      e.preventDefault();
      emw.actions.openSettings();
    }
  });
})();
