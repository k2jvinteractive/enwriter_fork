// Part 6d: colours the writer picks, and the light and dark themes.
//
// Text the writer colours is stored as an inline style on the text, and it is never rewritten. A
// colour that reads well on the dark page can fail on the light one, so this file does two things:
//   1. the ribbon's colour pickers start from the current theme instead of a fixed colour, and
//      follow it until the writer picks something of their own;
//   2. when a picked colour would be hard to read in the theme that is not showing, a small hint
//      appears next to the picker. The text itself is left exactly as the writer made it.
(() => {
  'use strict';
  const emw = window.emw;
  const P = window.emwPrefs;   // from boot.js; without it there is nothing to compare with
  if (!emw || !P) return;
  const root = document.documentElement;

  const HINT = 'This colour may be hard to read in the other theme.';
  const MIN_CONTRAST = 3;
  const HINT_MS = 6000;
  const HEX = /^#[0-9a-f]{6}$/i;

  // A theme variable as '#rrggbb', or '' when it is not a plain hex colour.
  function token(name) {
    try {
      const v = getComputedStyle(root).getPropertyValue(name).trim();
      return HEX.test(v) ? v.toLowerCase() : '';
    } catch { return ''; }
  }

  // The page colour of the theme that is NOT showing. Both are declared as tokens in styles.css,
  // because the light palette cannot be read while the dark one is applied.
  const otherPage = () => token(root.dataset.theme === 'light' ? '--page-dark' : '--page-light');

  function isHardToRead(hex) {
    const page = otherPage();
    return HEX.test(hex) && !!page && P.contrast(hex, page) < MIN_CONTRAST;
  }

  // The hint sits under the picker's button and does not move anything. It is a status region, so
  // a screen reader hears it when the text appears.
  function watch(input, host) {
    if (!input || !host) return;
    const tip = document.createElement('span');
    tip.className = 'color-hint';
    tip.setAttribute('role', 'status');
    host.append(tip);
    let timer = 0;
    const show = () => {
      clearTimeout(timer);
      tip.textContent = isHardToRead(input.value) ? HINT : '';
      if (tip.textContent) timer = setTimeout(() => { tip.textContent = ''; }, HINT_MS);
    };
    input.addEventListener('input', show);
    input.addEventListener('change', show);
  }

  // A picker that has not been used shows (and starts from) a theme colour; once the writer picks
  // one it keeps that colour, whatever the theme does.
  const followers = new Set();
  function paint(f) {
    if (!f.input.isConnected) { followers.delete(f); return; }   // a notes editor that was closed
    if (f.touched) return;
    const hex = token(f.name);
    if (!hex) return;
    f.input.value = hex;
    f.swatch.style.setProperty('--c', hex);
  }
  function follow(input, swatch, name) {
    if (!input || !swatch) return;
    const f = { input, swatch, name, touched: false };
    input.addEventListener('input', () => { f.touched = true; });
    followers.add(f);
    paint(f);
  }

  // boot.js announces every theme or accent change.
  root.addEventListener('emw:themechange', () => followers.forEach(paint));

  // ---- the ribbon ------------------------------------------------------------------------------
  const textIn = document.getElementById('rb-color');
  const dcIn = document.getElementById('rb-dc-color');
  follow(textIn, document.getElementById('sw-color'), '--writer-ink');
  if (textIn) watch(textIn, textIn.closest('label'));
  if (dcIn) watch(dcIn, dcIn.closest('label'));   // its start colour is set per chapter in editor.js

  emw.legibility = {
    watch, follow, isHardToRead,
    // The accent as readable text in the current theme: where pickers that have no colour start.
    accentHex: () => token('--accent-text') || '#e8caa4'
  };
})();
