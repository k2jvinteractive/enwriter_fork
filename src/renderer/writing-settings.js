// Part 5d: the Writing and Bottom bar sections of Settings, and the code that makes their
// values take effect at once. Values live in settings.json (emw.settings); this file only
// reads them, applies them to the page, and draws the two sections.
(() => {
  'use strict';
  const emw = window.emw;
  const st = emw.settings;
  if (!st || !st.ui || !emw.tabbar) return;   // settings.js and ui.js load first; without them there is nothing to extend
  const { el, row, segmented, resetLink } = st.ui;

  // ---- applying values ------------------------------------------------------------------
  const PAGE_WIDTHS = { narrow: '60ch', medium: '70ch', wide: '85ch' };
  const pageEl = document.getElementById('page');

  function applyPageWidth() {
    if (pageEl) pageEl.style.setProperty('--page-w', PAGE_WIDTHS[st.get('pageWidth')] || PAGE_WIDTHS.medium);
  }

  // smart-text.js reads this object on every keystroke, so editing it is all it takes.
  function applySmartText() {
    const s = emw.smartText && emw.smartText.settings;
    if (!s) return;
    s.quotes = !!st.get('smartQuotes');
    s.ellipsis = !!st.get('autoEllipsis');
    s.style = emw.smartText.styles[st.get('quoteStyle')] ? st.get('quoteStyle') : 'en';
  }

  const applyBar = () => emw.tabbar.apply(st.get('tabs'), st.get('statsSide'));

  applyPageWidth();
  applySmartText();
  applyBar();

  st.onChange((key) => {
    if (key === 'pageWidth') applyPageWidth();
    else if (key === 'smartQuotes' || key === 'autoEllipsis' || key === 'quoteStyle') applySmartText();
    else if (key === 'tabs' || key === 'statsSide') applyBar();
    // typewriter and autoHighlight are followed by editor.js and auto-highlight.js themselves;
    // the default font and size are followed by typography.js (the book's own choice wins); spacing is read
    // when an empty page is made; the autosave delay is read each time app.js schedules a save.
  });

  // ---- small controls -----------------------------------------------------------------------
  function checkbox(text, key, after) {
    const label = el('label', 'st-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!st.get(key);
    cb.addEventListener('change', () => { st.set(key, cb.checked); if (after) after(cb.checked); });
    label.append(cb, el('span', null, text));
    return label;
  }

  function select(label, options, current, onPick) {
    const s = el('select');
    s.setAttribute('aria-label', label);
    for (const [text, val] of options) {
      const o = el('option', null, text);
      o.value = String(val);
      s.append(o);
    }
    s.value = String(current);
    s.addEventListener('change', () => onPick(s.value));
    return s;
  }

  const SIZES = [10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72];
  const SPACINGS = [[ '1.0', 1], ['1.15', 1.15], ['1.5', 1.5], ['1.75', 1.75], ['2.0', 2], ['2.5', 2.5]];

  // ---- Writing -----------------------------------------------------------------------------------
  st.addSection({
    id: 'writing', label: 'Writing',
    render(pane, redo) {
      pane.append(el('h2', null, 'Writing'));

      pane.append(row('Page width', segmented('st-pagew',
        [['Narrow', 'narrow'], ['Medium', 'medium'], ['Wide', 'wide']], st.get('pageWidth'), (v) => st.set('pageWidth', v)),
      'How wide the column of text is in the Manuscript.'));

      // Default font, size and line spacing. The font button is the same picker the ribbon uses.
      const defaults = el('div', 'st-inline');
      const wrap = el('div', 'fontpick');
      const fontBtn = el('button', 'fp-btn');
      fontBtn.type = 'button';
      fontBtn.setAttribute('aria-haspopup', 'listbox');
      fontBtn.setAttribute('aria-label', 'Default font');
      const fontLabel = el('span', 'fp-label', st.get('writingFont') || 'Default serif');
      fontBtn.append(fontLabel);
      wrap.append(fontBtn);
      defaults.append(wrap,
        select('Default font size', SIZES.map((n) => [String(n), n]), st.get('writingSize'), (v) => st.set('writingSize', Number(v))),
        select('Default line spacing', SPACINGS, st.get('writingSpacing'), (v) => st.set('writingSpacing', Number(v))));
      pane.append(row('Default text', defaults, 'Font, size and line spacing for new text. Text you have already written keeps its look.'));
      emw.fontPicker(fontBtn, { onPick: (name) => { st.set('writingFont', name); fontLabel.textContent = name; } });

      pane.append(el('h3', 'st-sub', 'Typing'));

      const quoteStyle = segmented('st-qstyle', [['“English”', 'en'], ['«French»', 'fr'], ['„German“', 'de']],
        st.get('quoteStyle'), (v) => st.set('quoteStyle', v));
      const syncStyle = (on) => quoteStyle.querySelectorAll('input').forEach((i) => { i.disabled = !on; });
      pane.append(row('Smart quotes', checkbox('Curl quotes and apostrophes as you type', 'smartQuotes', syncStyle),
        'Press Backspace right after a conversion to get the plain character back.'));
      pane.append(row('Quote style', quoteStyle));
      syncStyle(!!st.get('smartQuotes'));
      pane.append(row('Ellipsis', checkbox('Turn three dots into …', 'autoEllipsis')));
      pane.append(row('Highlighting', checkbox('Highlight text as soon as it is selected', 'autoHighlight'),
        'The same switch as the button on the ribbon.'));
      pane.append(row('Typewriter mode', checkbox('Keep the line you are writing near the middle', 'typewriter'),
        'The same switch as the button on the ribbon.'));

      // Autosave delay: a slider with its value beside it.
      const slider = el('input');
      slider.type = 'range';
      slider.min = '200';
      slider.max = '2000';
      slider.step = '100';
      slider.value = String(st.get('autosaveDelay'));
      slider.setAttribute('aria-label', 'Autosave delay in milliseconds');
      const out = el('output', null, slider.value + ' ms');
      slider.addEventListener('input', () => { out.textContent = slider.value + ' ms'; st.set('autosaveDelay', Number(slider.value)); });
      const box = el('div', 'st-inline');
      box.append(slider, out);
      pane.append(row('Autosave delay', box, 'How long to wait after you stop typing before saving. Shorter saves sooner; longer does less disk work.'));

      pane.append(resetLink(['pageWidth', 'writingFont', 'writingSize', 'writingSpacing', 'smartQuotes', 'quoteStyle',
        'autoEllipsis', 'autoHighlight', 'typewriter', 'autosaveDelay'], redo));
    }
  });

  // ---- Bottom bar -------------------------------------------------------------------------------------
  // The row list always renders from the saved config, so what you see is what the bar has.
  const currentTabs = () => emw.tabbar.normalise(st.get('tabs'));
  const saveTabs = (cfg) => st.set('tabs', { order: cfg.order.slice(), hidden: cfg.hidden.slice() });

  function moveTab(id, targetId, after) {
    const cfg = currentTabs();
    if (id === targetId) return false;
    const order = cfg.order.filter((x) => x !== id);
    const at = order.indexOf(targetId);
    if (at < 0) return false;
    order.splice(after ? at + 1 : at, 0, id);
    saveTabs({ order, hidden: cfg.hidden });
    return true;
  }

  st.addSection({
    id: 'bottombar', label: 'Bottom bar',
    render(pane, redo) {
      pane.append(el('h2', null, 'Bottom bar'));

      const cfg = currentTabs();
      const list = el('ul', 'st-tabrows');
      list.setAttribute('aria-label', 'Tabs in the bottom bar, in order');
      let dragId = null;
      const clearMarks = () => list.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragging'));

      for (const id of cfg.order) {
        const tab = emw.tabbar.TABS.find((t) => t.id === id);
        const hidden = cfg.hidden.includes(id);
        const li = el('li', 'st-tabrow');
        li.draggable = true;
        li.tabIndex = 0;
        li.dataset.id = id;
        li.dataset.hidden = String(hidden);
        li.setAttribute('aria-label', tab.label + (hidden ? ', hidden' : ''));

        const grip = el('span', 'grip', '⋮⋮');
        grip.setAttribute('aria-hidden', 'true');
        const check = el('label', 'st-check');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = !hidden;
        cb.disabled = !tab.hideable;
        cb.setAttribute('aria-label', 'Show ' + tab.label);
        if (!tab.hideable) check.title = tab.label + ' is always shown';
        cb.addEventListener('change', () => {
          const now = currentTabs();
          const h = now.hidden.filter((x) => x !== id);
          if (!cb.checked) h.push(id);
          saveTabs({ order: now.order, hidden: h });
          redo();
        });
        // A checkbox inside a draggable row must not start a drag when clicked.
        check.addEventListener('mousedown', (e) => e.stopPropagation());
        check.append(cb, el('span', null, 'Show'));
        li.append(grip, el('span', 'name', tab.label), check);

        li.addEventListener('dragstart', (e) => {
          dragId = id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);   // Chromium will not start a drag without data
          li.classList.add('dragging');
        });
        // Alt+Up / Alt+Down moves the focused row, for keyboards.
        li.addEventListener('keydown', (e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.target !== li) return;
          e.preventDefault();
          const o = currentTabs().order;
          const i = o.indexOf(id);
          const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
          if (j < 0 || j >= o.length) return;
          moveTab(id, o[j], e.key === 'ArrowDown');
          redo();
          const again = [...document.querySelectorAll('.st-tabrow')].find((n) => n.dataset.id === id);
          if (again) again.focus();
        });
        list.append(li);
      }

      list.addEventListener('dragover', (e) => {
        if (!dragId) return;
        const li = e.target.closest('.st-tabrow');
        if (!li || li.dataset.id === dragId) { clearMarks(); list.querySelector('[data-id="' + dragId + '"]')?.classList.add('dragging'); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = li.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        clearMarks();
        list.querySelector('[data-id="' + dragId + '"]')?.classList.add('dragging');
        li.classList.add(after ? 'drop-after' : 'drop-before');
      });
      list.addEventListener('drop', (e) => {
        const li = e.target.closest('.st-tabrow');
        if (!dragId || !li) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        const moved = moveTab(dragId, li.dataset.id, e.clientY > r.top + r.height / 2);
        dragId = null;
        clearMarks();
        if (moved) redo();
      });
      list.addEventListener('dragend', () => { dragId = null; clearMarks(); });

      pane.append(row('Tabs', list,
        'Drag to reorder, or focus a row and press Alt+Up or Alt+Down. Home and Manuscript are always shown. A hidden tab is still in the View menu.'));

      pane.append(row('Word count', segmented('st-statsside', [['Left', 'left'], ['Right', 'right']], st.get('statsSide'),
        (v) => st.set('statsSide', v)), 'Which side of the bar the word count sits on.'));

      pane.append(resetLink(['tabs', 'statsSide'], redo));
    }
  });

  emw.actions.customiseBottomBar = () => st.open('bottombar');
})();
