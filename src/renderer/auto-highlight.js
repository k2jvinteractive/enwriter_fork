// Feature 2: auto-highlight toggle. When on, a selection that has "settled"
// (mouse released, shift-selection finished, double/triple click) is highlighted
// with the ribbon's current colour, then the caret collapses to its end.
// Selecting text that is already entirely that colour removes the highlight.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const emw = window.emw;
  const editor = $('#editor');
  const toggle = $('#rb-autohilite');
  const clearBtn = $('#rb-nohilite');
  const hiliteIn = $('#rb-hilite');
  if (!editor || !toggle || !hiliteIn || !emw.editor || !emw.editor.exec) return;

  const KEY = 'emwriter.autohilite';   // moves to settings.json when Feature 5 lands
  const NAV = /^(Arrow(Left|Right|Up|Down)|Home|End|Page(Up|Down))$/;
  const DELAY = 250;
  const DBLCLICK_DELAY = 400;          // long enough for a third click to cancel the word highlight

  let auto = false;
  let timer = 0;
  let mouseDown = false;   // a drag that started in the editor is in progress
  let composing = false;   // IME composition
  let pickerOpen = false;  // a colour picker has focus; clicking it must not fire us
  let shiftSelecting = false;

  // ---- persistence ---------------------------------------------------------
  function setAuto(on) {
    auto = on;
    toggle.setAttribute('aria-pressed', String(on));
    if (!on) cancel();
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
  }
  try { auto = localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }
  toggle.setAttribute('aria-pressed', String(auto));
  // Ribbon buttons already keep focus in the editor (see editor.js mousedown handler).
  toggle.addEventListener('click', () => setAuto(!auto));

  // ---- helpers -------------------------------------------------------------
  const cancel = () => { clearTimeout(timer); timer = 0; };
  const schedule = (ms = DELAY) => { cancel(); if (auto) timer = setTimeout(settle, ms); };

  // The browser serialises any CSS colour to rgb(), which is also what getComputedStyle returns.
  function normalise(value) {
    const t = document.createElement('span');
    t.style.backgroundColor = value;
    return t.style.backgroundColor;
  }

  function visibleBackground(node) {
    let el = node.parentElement;
    while (el && el !== editor) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
      el = el.parentElement;
    }
    return '';
  }

  // True when every non-blank character in the range already has this background.
  function entirelyHighlighted(range, rgb) {
    const root = range.commonAncestorContainer;
    const nodes = [];
    if (root.nodeType === Node.TEXT_NODE) nodes.push(root);
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n)) nodes.push(n);
    }
    let seen = false;
    for (const n of nodes) {
      const from = n === range.startContainer ? range.startOffset : 0;
      const to = n === range.endContainer ? range.endOffset : n.length;
      if (!n.data.slice(from, to).trim()) continue;
      seen = true;
      if (visibleBackground(n) !== rgb) return false;
    }
    return seen;
  }

  // Put the caret just after the highlight so the next typed character is not highlighted too.
  // Best effort: browsers decide which side of the boundary the caret styles from.
  function collapseAfter() {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    sel.collapseToEnd();
    const r = sel.getRangeAt(0);
    let node = r.endContainer;
    if (node.nodeType !== Node.TEXT_NODE || r.endOffset !== node.length) return;
    let outer = null;
    for (let el = node.parentElement; el && el !== editor; el = el.parentElement) {
      if (el.tagName !== 'SPAN' || !el.style.backgroundColor) break;
      if (el.lastChild !== node && el.lastChild !== outer) break;
      outer = el;
      node = el;
    }
    if (!outer) return;
    const after = document.createRange();
    after.setStartAfter(outer);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  }

  function settle() {
    timer = 0;
    if (!auto || mouseDown || composing || pickerOpen) return;
    if (document.activeElement !== editor) return;
    if (document.activeElement && document.activeElement.matches('input[type=color]')) return;
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !editor.contains(sel.anchorNode) || !editor.contains(sel.focusNode)) return;
    if (!sel.toString().trim()) return;   // nothing visible to highlight
    const rgb = normalise(hiliteIn.value);
    const remove = entirelyHighlighted(sel.getRangeAt(0), rgb);
    emw.editor.exec('hiliteColor', remove ? 'transparent' : hiliteIn.value);
    collapseAfter();
  }

  // ---- "No highlight" ------------------------------------------------------
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const sel = getSelection();
      if (!emw.editor.inEditor() || sel.isCollapsed) return;
      emw.editor.exec('hiliteColor', 'transparent');
    });
  }

  // ---- when has the selection settled? ---------------------------------------
  editor.addEventListener('mousedown', () => { mouseDown = true; cancel(); });
  // Listen on the document: a drag may be released outside the editor.
  document.addEventListener('mouseup', (e) => {
    if (!mouseDown) return;
    mouseDown = false;
    schedule(e.detail === 2 ? DBLCLICK_DELAY : DELAY);
  });

  editor.addEventListener('keydown', (e) => {
    cancel();   // still typing or extending
    if (e.shiftKey && NAV.test(e.key)) shiftSelecting = true;
  });
  editor.addEventListener('keyup', (e) => {
    if (!shiftSelecting) return;
    // Wait until Shift is let go (or the arrow is released after Shift), so each
    // keypress of a shift-arrow run extends the selection instead of highlighting it.
    if (e.key === 'Shift' || (NAV.test(e.key) && !e.shiftKey)) {
      shiftSelecting = false;
      schedule();
    }
  });

  editor.addEventListener('compositionstart', () => { composing = true; cancel(); });
  editor.addEventListener('compositionend', () => { composing = false; });

  // Colour pickers: Chromium gives no "opened" event, but the input holds focus while it is open.
  for (const input of document.querySelectorAll('#ribbon input[type=color]')) {
    input.addEventListener('focus', () => { pickerOpen = true; cancel(); });
    input.addEventListener('blur', () => { pickerOpen = false; });
    input.addEventListener('change', () => { pickerOpen = false; });
  }
})();
