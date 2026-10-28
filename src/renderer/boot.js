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

  // STUB for part 6c. Picks a readable text colour for the accent with a simple luminance
  // threshold. 6c replaces the body with the real accent roles; every caller stays the same.
  function updateAccentInk(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    root.style.setProperty('--accent-ink', lum > 0.35 ? '#1f1a14' : '#f6f1ea');
  }

  const resolvedTheme = (s) => (s.theme === 'system' ? (light.matches ? 'light' : 'dark') : s.theme);

  function apply(s) {
    current = { ...current, ...s };
    // The light palette arrives in part 6d; until then data-theme="light" has no styles and the
    // app stays dark. The attribute is already the hook those styles will use.
    root.dataset.theme = resolvedTheme(current);
    root.dataset.themePref = current.theme;
    root.style.setProperty('--accent', current.accent);
    updateAccentInk(current.accent);
    // Explicit "reduce" forces it on; null follows the OS through the media query in the CSS.
    root.dataset.motion = current.reduceMotion === true ? 'reduce' : '';
    try { window.api.setZoom(current.uiScale / 100); } catch { /* keep the current zoom */ }
  }

  // "Match system" must follow the OS live.
  light.addEventListener('change', () => { if (current.theme === 'system') apply({}); });

  window.emwPrefs = { DEFAULTS, apply, updateAccentInk, current: () => ({ ...current }), osReducedMotion: () => motion.matches };
  apply({});
})();
