// Smart quotes and automatic ellipsis, applied as the writer types.
// Usage: emw.smartText.apply(inputEvent, rootEl) from an `input` handler on a
// contenteditable root (the manuscript editor, the notes mini editor).
(() => {
  'use strict';
  const emw = window.emw;

  // Quote style is a plain lookup table: [opening, closing]. No locale detection.
  const STYLES = {
    en: { label: 'English “ ” ‘ ’', dq: ['“', '”'], sq: ['‘', '’'] },
    fr: { label: 'French « » ‹ ›', dq: ['«', '»'], sq: ['‹', '›'] },
    de: { label: 'German „ “ ‚ ‘', dq: ['„', '“'], sq: ['‚', '‘'] }
  };
  const APOSTROPHE = '’';

  // Feature 5 (Settings) will persist and edit this object; until then it stays at defaults.
  const settings = { quotes: true, ellipsis: true, style: 'en' };

  const OPENERS = new Set(['(', '[', '{', '—', '–', '“', '‘', '«', '„', '‚', '‹']);
  const SINGLE_OPEN = '‘‚‹';
  // Words that start with an elided apostrophe: 'em, 'til, 'cause ...
  const ELISION = '(?:em|til|cause|tis|twas|bout)';
  const AFTER_ELISION_QUOTE = new RegExp(`(^|[^\\p{L}\\p{N}])([${SINGLE_OPEN}])(${ELISION})$`, 'iu');
  const AFTER_DIGIT_QUOTE = new RegExp(`(^|[^\\p{L}\\p{N}])([${SINGLE_OPEN}])$`, 'u');

  const isLetter = (c) => !!c && /\p{L}/u.test(c);
  const isSpace = (c) => !!c && /\s/.test(c);

  let busy = false;   // our own replacement fires `input` again; ignore those events
  let last = null;    // the most recent conversion, so Backspace can undo it

  const blockOf = (node, root) => {
    let n = node.parentElement;
    while (n && n !== root && !/^(P|H[1-6]|LI|BLOCKQUOTE|DIV)$/.test(n.tagName)) n = n.parentElement;
    return n;
  };

  // The character before position `at` in `node`, looking back into the previous text node
  // of the same paragraph. Returns '' at the start of a paragraph or after a line break.
  function charBefore(node, at, root) {
    if (at > 0) return node.data[at - 1];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    walker.currentNode = node;
    const prev = walker.previousNode();
    if (!prev || !prev.data.length || blockOf(prev, root) !== blockOf(node, root)) return '';
    try {
      const gap = document.createRange();
      gap.setStart(prev, prev.data.length);
      gap.setEnd(node, 0);
      if (gap.cloneContents().querySelector('br')) return '';
    } catch { /* ignore: fall through and trust the previous node */ }
    return prev.data[prev.data.length - 1];
  }

  function quoteFor(ch, before) {
    const style = STYLES[settings.style] || STYLES.en;
    const pair = ch === '"' ? style.dq : style.sq;
    // After a letter a single quote is an apostrophe or a closing quote; both are ’ (don’t, dogs’).
    // The next character isn't typed yet, so we can't (and needn't) look at it.
    if (ch === "'" && isLetter(before)) return APOSTROPHE;
    const opening = !before || isSpace(before) || OPENERS.has(before);
    return opening ? pair[0] : pair[1];
  }

  // Replace text[start, end) of `node` with `text` as ONE editing command, so a single
  // Ctrl+Z restores what was there. Same technique as dashToEmDash() in editor.js.
  function replace(node, start, end, text) {
    const sel = getSelection();
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    sel.removeAllRanges();
    sel.addRange(r);
    busy = true;
    try { document.execCommand('insertText', false, text); } finally { busy = false; }
  }

  // Convert, and remember it so Backspace right afterwards can revert to what was typed.
  function convert(root, node, start, end, converted, typed) {
    replace(node, start, end, converted);
    const sel = getSelection();
    const n = sel.rangeCount ? sel.anchorNode : null;
    if (n && n.nodeType === Node.TEXT_NODE && root.contains(n)) {
      const stop = sel.anchorOffset;
      last = { root, node: n, start: stop - converted.length, end: stop, converted, typed };
    } else {
      last = null;
    }
  }

  function apply(e, root) {
    if (busy) return;       // re-entrancy guard: the replacement below fires `input` again
    last = null;            // any other input ends the "Backspace reverts" window
    if (!e || e.inputType !== 'insertText' || e.isComposing || typeof e.data !== 'string' || e.data.length !== 1) return;
    if (!root || !root.isContentEditable) return;
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode;
    const at = sel.anchorOffset;
    if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node) || at < 1) return;
    if (node.data[at - 1] !== e.data) return;
    if (node.parentElement && node.parentElement.closest('a, input, textarea')) return;   // never inside links
    const ch = e.data;

    if ((ch === '"' || ch === "'") && settings.quotes) {
      const before = charBefore(node, at - 1, root);
      const q = quoteFor(ch, before);
      if (q !== ch) convert(root, node, at - 1, at, q, ch);
      return;
    }

    if (ch === '.' && settings.ellipsis) {
      // Only the third dot of a run: leave `..` alone, and don't touch a longer run being edited.
      if (node.data.slice(at - 3, at) === '...' && node.data[at - 4] !== '.' && node.data[at] !== '.') {
        convert(root, node, at - 3, at, '…', '...');
      }
      return;
    }

    if (!settings.quotes || isLetter(ch) || ch === "'" || ch === '"') return;
    const head = node.data.slice(0, at - 1);

    // '90s: an opening single quote followed by a digit was really an apostrophe.
    if (/\d/.test(ch)) {
      const m = AFTER_DIGIT_QUOTE.exec(head);
      if (m) {
        const s = head.length - 1;
        convert(root, node, s, at, APOSTROPHE + ch, "'" + ch);
      }
      return;
    }

    // 'em, 'til, 'cause: only decidable once the word is finished, so fix it at the boundary.
    const m = AFTER_ELISION_QUOTE.exec(head);
    if (m) {
      const s = head.length - m[3].length - 1;
      convert(root, node, s, at, APOSTROPHE + m[3] + ch, "'" + m[3] + ch);
    }
  }

  // Backspace right after a conversion reverts it to the characters the writer typed.
  // Captured at document level so it covers every root without extra wiring.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !last) return;
    const { root, node, start, end, converted, typed } = last;
    const sel = getSelection();
    const ok = sel.rangeCount && sel.isCollapsed && sel.anchorNode === node && sel.anchorOffset === end &&
      root.contains(node) && node.data.slice(start, end) === converted;
    last = null;
    if (!ok) return;
    e.preventDefault();
    replace(node, start, end, typed);
  }, true);

  emw.smartText = { apply, settings, styles: STYLES };
})();
