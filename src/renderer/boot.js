// Runs synchronously in <head>, before the stylesheet paints the body, so the saved theme,
// accent and zoom are on screen from the very first frame (no flash of the wrong look).
// It is a plain script on purpose: ui.js later replaces window.emw, so the shared bits live on
// window.emwPrefs, which settings.js picks up.
(() => {
  'use strict';
  const root = document.documentElement;

  const DEFAULTS = { theme: 'dark', accent: '#e8caa4', uiScale: 100, reduceMotion: null, penName: '' };

  let current = { ...DEFAULTS };
  try {
    // Blocking read from the main process; if it fails we just keep the defaults.
    const s = window.api && window.api.settingsSync && window.api.settingsSync();
    if (s && typeof s === 'object') current = { ...DEFAULTS, ...s };
  } catch { /* defaults */ }

  const light = window.matchMedia('(prefers-color-scheme: light)');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---- accent roles (part 6c) -----------------------------------------------------------------
  // --accent       fills, borders, focus rings, drop marks (the colour as chosen)
  // --accent-text  the accent used as text; nudged toward --ink until it reaches 4.5:1 on --bg
  // --accent-ink   text sitting on an accent fill; the darker or lighter ink with more contrast
  // This lives here, not in settings.js, because settings.js is deferred and the roles must be
  // right on the very first frame. settings.js re-exports the helpers.
  const INK_DARK = '#1f1a14', INK_LIGHT = '#f6f1ea';
  const toRgb = (hex) => {
    let h = String(hex).trim().replace('#', '');
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    const n = parseInt(h, 16);
    return Number.isNaN(n) || h.length !== 6 ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const luminance = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  // WCAG contrast ratio of two '#rrggbb' colours (1 to 21). Unparseable input counts as 1.
  function contrast(a, b) {
    const x = toRgb(a), y = toRgb(b);
    if (!x || !y) return 1;
    const l1 = luminance(x), l2 = luminance(y);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  // A theme variable as '#rrggbb', read after data-theme is set. rgb() is what getComputedStyle returns.
  function themeColor(name, fallback) {
    try {
      const v = getComputedStyle(root).getPropertyValue(name).trim();
      const m = v.match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/);
      if (m) return toHex([+m[1], +m[2], +m[3]]);
      if (toRgb(v)) return toHex(toRgb(v));
    } catch { /* fall through */ }
    return fallback;
  }
  function accentText(accent, bg, ink) {
    const a = toRgb(accent), i = toRgb(ink);
    if (!a || !i || contrast(accent, bg) >= 4.5) return accent;
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const c = toHex(mix(a, i, t));
      if (contrast(c, bg) >= 4.5) return c;
    }
    return ink;
  }
  const accentInk = (accent) => (contrast(accent, INK_DARK) >= contrast(accent, INK_LIGHT) ? INK_DARK : INK_LIGHT);

  function updateAccentRoles(hex) {
    if (!toRgb(hex)) return;
    root.style.setProperty('--accent-ink', accentInk(hex));
    root.style.setProperty('--accent-text', accentText(hex, themeColor('--bg', '#222222'), themeColor('--ink', '#dcdcdc')));
  }

  const resolvedTheme = (s) => (s.theme === 'system' ? (light.matches ? 'light' : 'dark') : s.theme);

  function apply(s) {
    current = { ...current, ...s };
    // The light palette arrives in part 6d; until then data-theme="light" has no styles and the
    // app stays dark. The attribute is already the hook those styles will use.
    root.dataset.theme = resolvedTheme(current);
    root.dataset.themePref = current.theme;
    root.style.setProperty('--accent', current.accent);
    updateAccentRoles(current.accent);
    // Explicit "reduce" forces it on; null follows the OS through the media query in the CSS.
    root.dataset.motion = current.reduceMotion === true ? 'reduce' : '';
    try { window.api.setZoom(current.uiScale / 100); } catch { /* keep the current zoom */ }
  }

  // "Match system" must follow the OS live.
  light.addEventListener('change', () => { if (current.theme === 'system') apply({}); });
  // Main also forwards native theme updates; re-resolving covers the case where the media query
  // lags behind a themeSource change.
  try { window.api.onThemeUpdated(() => { if (current.theme === 'system') apply({}); }); } catch { /* media query still works */ }

  window.emwPrefs = { DEFAULTS, apply, updateAccentRoles, contrast, accentText, accentInk, current: () => ({ ...current }), osReducedMotion: () => motion.matches };
  apply({});
})();
