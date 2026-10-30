// System font list and the searchable font picker.
(() => {
  'use strict';
  const emw = window.emw;

  // Used only if the browser can't list installed fonts: these are probed one by one.
  const COMMON = ['Arial', 'Arial Black', 'Baskerville', 'Bookman Old Style', 'Calibri', 'Cambria', 'Candara', 'Century Gothic',
    'Charter', 'Cinzel', 'Consolas', 'Constantia', 'Courier New', 'Courier Prime', 'Crimson Text', 'DejaVu Sans', 'DejaVu Serif', 'Didot',
    'EB Garamond', 'Fira Sans', 'Forum', 'Franklin Gothic Medium', 'Futura', 'Garamond', 'Georgia', 'Gill Sans', 'Goudy Old Style',
    'Helvetica', 'Helvetica Neue', 'Hoefler Text', 'Impact', 'Inter', 'Iowan Old Style', 'Lato', 'Liberation Sans', 'Liberation Serif',
    'Libre Baskerville', 'Literata', 'Lora', 'Lucida Console', 'Lucida Sans', 'Menlo', 'Merriweather', 'Monaco', 'Montserrat',
    'New York', 'Noto Sans', 'Noto Serif', 'Open Sans', 'Optima', 'Palatino', 'Palatino Linotype', 'Perpetua', 'Playfair Display',
    'Roboto', 'Rockwell', 'Segoe UI', 'Sitka Text', 'Source Serif Pro', 'Spectral', 'Special Elite', 'Tahoma', 'Times New Roman',
    'Trebuchet MS', 'Ubuntu', 'Verdana'];

  const probe = (() => {
    const ctx = document.createElement('canvas').getContext('2d');
    const bases = ['monospace', 'serif', 'sans-serif'];
    const sample = 'mmmmmmmmmmlli wWQ';
    const width = (font) => { ctx.font = `72px ${font}`; return ctx.measureText(sample).width; };
    const baseline = bases.map(width);
    return (name) => bases.some((b, i) => width(`"${name}", ${b}`) !== baseline[i]);
  })();

  let cache = null;
  let loading = null;
  function list() {
    if (cache) return Promise.resolve(cache);
    if (!loading) {
      loading = (async () => {
        let names = [];
        try {
          if (window.queryLocalFonts) names = [...new Set((await window.queryLocalFonts()).map((f) => f.family))];
        } catch { /* no permission or no API: use the fallback below */ }
        if (!names.length) names = COMMON.filter(probe);
        names.sort((a, b) => a.localeCompare(b));
        cache = names;
        return names;
      })();
    }
    return loading;
  }
  emw.fonts = { list };

  // Turns a button into a font picker. `onPick(name)` runs when a font is chosen.
  // `onPreview(name)` (optional) runs while the writer browses the list, and `onPreview(null)` when the list closes
  // without a choice, so the caller can show the font cheaply and put the old one back.
  emw.fontPicker = (btn, { onPick, onPreview }) => {
    const wrap = btn.parentElement;
    const pop = document.createElement('div');
    pop.className = 'fp-pop';
    pop.hidden = true;
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'fp-search';
    search.placeholder = 'Search fonts…';
    search.setAttribute('aria-label', 'Search fonts');
    const ul = document.createElement('ul');
    ul.className = 'fp-list';
    ul.setAttribute('role', 'listbox');
    pop.append(search, ul);
    wrap.append(pop);

    let names = [];
    let shown = [];
    let active = 0;
    let touched = false;   // the keyboard moved through the list, so the active row is the one being previewed
    const preview = (name) => { if (onPreview) onPreview(name); };

    function paint() {
      [...ul.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      ul.children[active]?.scrollIntoView({ block: 'nearest' });
      if (touched && shown[active]) preview(shown[active]);
    }
    function render() {
      const q = search.value.trim().toLowerCase();
      shown = names.filter((n) => !q || n.toLowerCase().includes(q));
      if (!shown.length) { const li = document.createElement('li'); li.className = 'fp-none'; li.textContent = 'No fonts match'; ul.replaceChildren(li); return; }
      ul.replaceChildren(...shown.map((n) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.dataset.font = n;
        li.textContent = n;
        li.style.fontFamily = `"${n}", sans-serif`;
        return li;
      }));
      active = 0;
      paint();
    }
    // A close without a choice puts the previewed font back.
    function close(chosen = false) {
      if (pop.hidden) return;
      pop.hidden = true;
      touched = false;
      if (!chosen) preview(null);
    }
    async function open() {
      pop.hidden = false;
      ul.textContent = 'Loading fonts…';
      search.value = '';
      touched = false;
      search.focus();
      names = await list();   // the first call happens inside the click, which is what lets the browser read system fonts
      render();
    }
    function pick(name) { close(true); onPick(name); }

    btn.addEventListener('click', () => (pop.hidden ? open() : close()));
    search.addEventListener('input', () => { touched = false; preview(null); render(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); touched = true; active = Math.min(shown.length - 1, active + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); touched = true; active = Math.max(0, active - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    ul.addEventListener('mousedown', (e) => e.preventDefault());
    // The pointer previews too; leaving the list goes back to the keyboard's row, or to the old font.
    ul.addEventListener('mouseover', (e) => { const li = e.target.closest('li[data-font]'); if (li) preview(li.dataset.font); });
    ul.addEventListener('mouseleave', () => preview(touched && shown[active] ? shown[active] : null));
    ul.addEventListener('click', (e) => { const li = e.target.closest('li[data-font]'); if (li) pick(li.dataset.font); });
    document.addEventListener('mousedown', (e) => { if (!pop.hidden && !wrap.contains(e.target)) close(); });
  };
})();
