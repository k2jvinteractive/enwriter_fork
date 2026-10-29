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
  function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function fromHsl([h, s, l]) {
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    return [0, 8, 4].map((n) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  }
  // `bgs` is one '#rrggbb' or a list: the text has to reach 4.5:1 on all of them.
  // On a dark theme the accent is lightened toward the ink. On a light theme mixing toward the dark
  // ink would turn every accent into the same grey-brown (and the active tab would look quieter than
  // the inactive ones), so there it is darkened in HSL instead, which keeps its hue and richness.
  function accentText(accent, bgs, ink) {
    const list = Array.isArray(bgs) ? bgs : [bgs];
    const ok = (c) => list.every((b) => contrast(c, b) >= 4.5);
    const a = toRgb(accent), i = toRgb(ink);
    if (!a || !i || ok(accent)) return accent;
    if (luminance(i) < luminance(a)) {
      const [h, s, l] = toHsl(a);
      for (let x = l - 0.01; x >= 0; x -= 0.01) {
        const c = toHex(fromHsl([h, s, x]));
        if (ok(c)) return c;
      }
      return ink;
    }
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const c = toHex(mix(a, i, t));
      if (ok(c)) return c;
    }
    return ink;
  }
  const accentInk = (accent) => (contrast(accent, INK_DARK) >= contrast(accent, INK_LIGHT) ? INK_DARK : INK_LIGHT);

  // Accent text sits on more than the app background: hovered and pressed rows, the page, menus,
  // dialogs, the notes editor, and avatars (a card tinted with the accent). In the dark theme the
  // lightest of these is the hard one, in the light theme the darkest, so check them all.
  const ACCENT_SURFACES = ['--bg', '--page', '--ribbon', '--hover', '--pressed', '--surface-raised',
    '--surface-card-inset', '--surface-sunken', '--surface-toast'];
  function accentSurfaces(hex) {
    const list = ACCENT_SURFACES.map((n) => themeColor(n, null)).filter(Boolean);
    // .av mixes 22% accent into the card inset colour; accent text has to read on that too.
    const inset = themeColor('--surface-card-inset', null);
    if (inset) list.push(toHex(mix(toRgb(inset), toRgb(hex), 0.22)));
    return list.length ? list : ['#222222'];
  }

  function updateAccentRoles(hex) {
    if (!toRgb(hex)) return;
    root.style.setProperty('--accent-ink', accentInk(hex));
    root.style.setProperty('--accent-text', accentText(hex, accentSurfaces(hex), themeColor('--ink', '#dcdcdc')));
  }

  const resolvedTheme = (s) => (s.theme === 'system' ? (light.matches ? 'light' : 'dark') : s.theme);

  function apply(s) {
    current = { ...current, ...s };
    root.dataset.theme = resolvedTheme(current);
    root.dataset.themePref = current.theme;
    root.style.setProperty('--accent', current.accent);
    updateAccentRoles(current.accent);
    // Explicit "reduce" forces it on; null follows the OS through the media query in the CSS.
    root.dataset.motion = current.reduceMotion === true ? 'reduce' : '';
    try { window.api.setZoom(current.uiScale / 100); } catch { /* keep the current zoom */ }
    // Things that mirror a theme colour in JS (the ribbon's colour pickers) repaint on this.
    try { root.dispatchEvent(new CustomEvent('emw:themechange', { detail: { theme: root.dataset.theme } })); } catch { /* nothing is listening yet */ }
  }

  // "Match system" must follow the OS live.
  light.addEventListener('change', () => { if (current.theme === 'system') apply({}); });
  // Main also forwards native theme updates; re-resolving covers the case where the media query
  // lags behind a themeSource change.
  try { window.api.onThemeUpdated(() => { if (current.theme === 'system') apply({}); }); } catch { /* media query still works */ }

  window.emwPrefs = { DEFAULTS, apply, updateAccentRoles, contrast, accentText, accentInk, current: () => ({ ...current }), osReducedMotion: () => motion.matches };
  apply({});
})();
