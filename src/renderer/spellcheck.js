// Spell check on demand (part 7b). The ribbon button (and F7) switch it on and off for the whole
// session; with it on, right-clicking a flagged word offers corrections. The renderer cannot see
// the spell checker, so main.js reports each right-click ('spell:context') and this file turns the
// report into the one context menu used in every editable field: corrections, Cut, Copy, Paste,
// Select all, plus anything another file adds (the Darlings items) through emw.spell.setExtra.
(() => {
  'use strict';
  const emw = window.emw;
  const st = emw.settings;
  const editor = document.getElementById('editor');
  const button = document.getElementById('rb-spell');
  if (!st || !editor) return;

  const isOn = () => st.get('spellcheck') === true;

  // ---- the switch ------------------------------------------------------------------------------
  // Fields that hold prose follow the setting. Names, search boxes and the novel title stay "false".
  const PROSE = '#editor, #sd-title, #sd-description, .mini-area';
  const applyAttrs = (on) => document.querySelectorAll(PROSE).forEach((n) => { n.spellcheck = on; });

  // Chromium does not always re-check a field that already has focus. Blurring and refocusing it,
  // with the selection put back, makes the underlines appear or go at once without moving the caret.
  function nudge() {
    const a = document.activeElement;
    if (!a || !a.matches || !a.matches(PROSE)) return;
    try {
      if (a.isContentEditable) {
        const s = getSelection();
        const r = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
        a.blur();
        a.focus({ preventScroll: true });
        if (r) { s.removeAllRanges(); s.addRange(r); }
      } else if (typeof a.selectionStart === 'number') {
        const [s, e, d] = [a.selectionStart, a.selectionEnd, a.selectionDirection];
        a.blur();
        a.focus({ preventScroll: true });
        a.setSelectionRange(s, e, d);
      }
    } catch { /* the underlines will still update on the next edit */ }
  }

  function paintButton() {
    if (!button) return;
    button.setAttribute('aria-pressed', String(isOn()));
    const k = emw.keys && emw.keys.display('toggleSpellcheck');
    button.title = (isOn() ? 'Turn spell check off' : 'Turn spell check on') + (k ? ` (${k})` : '');
  }

  function toggle() {
    st.set('spellcheck', !isOn());
    applyAttrs(isOn());
    paintButton();
    // Save now rather than after the 300 ms debounce, so main switches the checker straight away.
    Promise.resolve(st.flush()).then(nudge, nudge);
  }

  applyAttrs(isOn());
  paintButton();
  if (button) button.addEventListener('click', toggle);
  st.onChange((key) => { if (key === 'spellcheck') { applyAttrs(isOn()); paintButton(); } });   // e.g. a reset elsewhere
  emw.actions.toggleSpellcheck = toggle;
  if (emw.keys) {
    emw.keys.register({ id: 'toggleSpellcheck', label: 'Spell check', group: 'Writing', keys: 'F7' });
    emw.keys.onChange(paintButton);
  }

  // ---- the context menu --------------------------------------------------------------------------
  let extra = null;       // { items, at } from another file's contextmenu handler
  let fallback = 0;
  const FRESH = 3000;

  // Remember what was selected when the menu opened: opening it moves focus onto the menu, and
  // Cut, Copy, Paste and the replacement all need the field and selection back.
  function snapshot() {
    const f = document.activeElement;
    if (!f) return () => {};
    if (f.isContentEditable) {
      const s = getSelection();
      const r = s.rangeCount && f.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
      return () => {
        f.focus({ preventScroll: true });
        if (r) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      };
    }
    if (typeof f.selectionStart === 'number') {
      const [a, b, d] = [f.selectionStart, f.selectionEnd, f.selectionDirection];
      return () => { f.focus({ preventScroll: true }); try { f.setSelectionRange(a, b, d); } catch { /* ignore */ } };
    }
    return () => f.focus({ preventScroll: true });
  }

  function show(d) {
    clearTimeout(fallback);
    if (!d || !d.inEditable) return;   // other places keep their own menus (or none)
    const back = snapshot();
    const cmd = (name) => () => { back(); document.execCommand(name); };
    const items = [];

    if (d.word) {
      if (d.suggestions.length) {
        d.suggestions.forEach((word, i) => items.push({
          label: word, strong: i === 0,
          run: () => {
            back();
            Promise.resolve(window.api.spellReplace(word)).then((ok) => {
              if (!ok) emw.toast('Could not apply that correction. Try right-clicking the word again.');
            }, () => emw.toast('Could not apply that correction.'));
          }
        }));
      } else {
        items.push({ label: 'No suggestions', disabled: true, run() {} });
      }
      // "Add to dictionary" comes from spell-dictionary.js (part 7c), which sets emw.spell.addWord.
      if (emw.spell && typeof emw.spell.addWord === 'function') {
        items.push(null, { label: 'Add to dictionary', run: () => { back(); emw.spell.addWord(d.word); } });   // back(): the field must have focus for the underline to refresh
      }
      items.push(null);
    }

    items.push(
      { label: 'Cut', disabled: !d.canCut, run: cmd('cut') },
      { label: 'Copy', disabled: !d.canCopy, run: cmd('copy') },
      { label: 'Paste', disabled: !d.canPaste, run: () => { back(); if (!document.execCommand('paste')) emw.toast('Use Ctrl+V to paste'); } },
      { label: 'Select all', run: cmd('selectAll') }
    );

    if (extra && Date.now() - extra.at < FRESH) items.push(null, ...extra.items);
    extra = null;

    const x = Number.isFinite(d.x) ? d.x : 0, y = Number.isFinite(d.y) ? d.y : 0;
    emw.menu(x, y, items);
  }

  // Another file (darlings.js) has items that belong in the editor's menu. They are used once,
  // for the menu that follows, and dropped if none arrives.
  emw.spell = { ...(emw.spell || {}), recheck: nudge, setExtra: (items) => { extra = { items, at: Date.now() }; } };

  try { window.api.onSpellContext(show); } catch { /* no bridge: the fallback below still gives a menu */ }

  // If the main process never reports a right-click in the editor, still show Cut, Copy, Paste and
  // Select all, so a missing report can never leave the editor without a menu.
  editor.addEventListener('contextmenu', (e) => {
    clearTimeout(fallback);
    const { clientX: x, clientY: y } = e;
    fallback = setTimeout(() => {
      const has = !getSelection().isCollapsed;
      show({ x, y, word: '', suggestions: [], canCut: has, canCopy: has, canPaste: true, inEditable: true });
    }, 600);
  });
})();
