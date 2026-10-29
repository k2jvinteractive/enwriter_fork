// The rich-text editor and its ribbon. Uses the browser's built-in editing
// engine (contenteditable), which keeps typing instant.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const emw = window.emw;
  const editor = $('#editor');
  const page = $('#page');
  const ribbon = $('#ribbon');
  const blockSel = $('#rb-block');
  const fontBtn = $('#rb-font');
  const sizeSel = $('#rb-size');
  const spacingSel = $('#rb-spacing');
  const colorIn = $('#rb-color');
  const hiliteIn = $('#rb-hilite');

  let savedRange = null;   // last selection inside the editor (survives focus moving to the ribbon)
  let pendingSize = null;  // font size chosen while the caret was collapsed
  let rafId = 0;

  document.execCommand('defaultParagraphSeparator', false, 'p');

  // ---- helpers -------------------------------------------------------------
  const inEditor = () => {
    const s = getSelection();
    return s.rangeCount > 0 && editor.contains(s.anchorNode);
  };

  function restore() {
    if (document.activeElement === editor && inEditor()) return;
    editor.focus();
    if (savedRange) {
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(savedRange);
    }
  }

  const CSS_CMDS = new Set(['foreColor', 'hiliteColor', 'fontName', 'fontSize',
    'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull']);

  function exec(cmd, value = null) {
    restore();
    document.execCommand('styleWithCSS', false, CSS_CMDS.has(cmd));
    document.execCommand(cmd, false, value);
    refreshState();
  }

  const BLOCKS = 'p,h1,h2,h3,li,div';
  function selectedBlocks() {
    const sel = getSelection();
    if (!sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    return [...editor.querySelectorAll(BLOCKS)].filter(
      (el) => range.intersectsNode(el) && !el.querySelector(BLOCKS)
    );
  }

  const fireInput = () => editor.dispatchEvent(new Event('input', { bubbles: true }));

  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function safeUrl(raw) {
    const u = (raw || '').trim();
    if (!u || u.startsWith('#')) return '';
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '';   // blocks javascript:, data:, file:
    return 'https://' + u.replace(/^\/+/, '');
  }

  // ---- ribbon state --------------------------------------------------------
  const stateButtons = [...ribbon.querySelectorAll('[data-state]')];
  const BLOCK_VALUES = ['p', 'h1', 'h2', 'h3', 'blockquote'];

  function refreshState() {
    if (!inEditor()) return;
    for (const b of stateButtons) {
      let on = false;
      try { on = document.queryCommandState(b.dataset.cmd); } catch { /* ignore */ }
      b.setAttribute('aria-pressed', String(on));
    }
    const block = (document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, '');
    blockSel.value = BLOCK_VALUES.includes(block) ? block : 'p';

    const anchor = getSelection().anchorNode;
    const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    if (el) {
      const cs = getComputedStyle(el);
      sizeSel.value = String(Math.round(parseFloat(cs.fontSize)));
      fontBtn.querySelector('.fp-label').textContent = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() || 'Font';
      const blk = el.closest(BLOCKS);
      const lh = blk && blk.style.lineHeight ? blk.style.lineHeight : '1.75';
      spacingSel.value = [...spacingSel.options].some((o) => o.value === lh) ? lh : '1.75';
    }
  }

  document.addEventListener('selectionchange', () => {
    if (!inEditor()) return;
    savedRange = getSelection().getRangeAt(0).cloneRange();
    if (!rafId && !ribbon.hidden) {
      rafId = requestAnimationFrame(() => { rafId = 0; refreshState(); });
    }
  });

  // ---- ribbon actions ------------------------------------------------------
  // Buttons must not steal focus from the editor, or the selection is lost.
  ribbon.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

  ribbon.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cmd]');
    if (!b) return;
    const cmd = b.dataset.cmd;
    if (cmd === 'clear') clearFormatting();
    else if (cmd === 'link') addLink();
    else exec(cmd);
  });

  blockSel.addEventListener('change', () => exec('formatBlock', `<${blockSel.value}>`));
  emw.fontPicker(fontBtn, { onPick: (name) => exec('fontName', name) });
  sizeSel.addEventListener('change', () => applyFontSize(Number(sizeSel.value)));
  spacingSel.addEventListener('change', () => {
    restore();
    selectedBlocks().forEach((b) => { b.style.lineHeight = spacingSel.value === '1.75' ? '' : spacingSel.value; });
    fireInput();
  });

  for (const [input, swatch, cmd] of [[colorIn, '#sw-color', 'foreColor'], [hiliteIn, '#sw-hilite', 'hiliteColor']]) {
    const sw = $(swatch);
    sw.style.setProperty('--c', input.value);
    input.addEventListener('input', () => sw.style.setProperty('--c', input.value));
    input.addEventListener('change', () => exec(cmd, input.value));
  }

  function applyFontSize(px) {
    restore();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('fontSize', false, '7');   // marker size, replaced with the real one below
    if (getSelection().isCollapsed) pendingSize = px;
    fixFontSizes(px);
    refreshState();
  }

  function fixFontSizes(px) {
    editor.querySelectorAll('font[size="7"], span[style*="xxx-large"]').forEach((el) => {
      if (el.tagName === 'FONT') {
        const span = document.createElement('span');
        while (el.firstChild) span.appendChild(el.firstChild);
        el.replaceWith(span);
        el = span;
      }
      el.style.fontSize = px + 'px';
    });
  }

  function clearFormatting() {
    restore();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('removeFormat');
    document.execCommand('formatBlock', false, '<p>');
    selectedBlocks().forEach((b) => b.removeAttribute('style'));
    fireInput();
    refreshState();
  }

  async function addLink() {
    const url = await emw.ask({ message: 'Link address', input: 'https://', okLabel: 'Add link' });
    const href = safeUrl(url === 'https://' ? '' : url);
    if (!href) return;
    restore();
    if (savedRange && !savedRange.collapsed) exec('createLink', href);
    else exec('insertHTML', `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`);
  }

  // ---- typing behaviour ----------------------------------------------------
  const updateEmpty = () => {
    editor.classList.toggle('empty', !editor.textContent && !editor.querySelector('hr') && editor.children.length <= 1);
  };

  editor.addEventListener('input', (e) => {
    if (pendingSize) { fixFontSizes(pendingSize); pendingSize = null; }
    updateEmpty();
    if (e.inputType === 'insertText' && e.data === '-') dashToEmDash();
    // Every input event goes in: smartText also uses them to end its "Backspace reverts" window.
    if (emw.smartText) emw.smartText.apply(e, editor);
    if (typewriter) requestAnimationFrame(centerCaret);
  });

  // Typing -- turns into an em dash.
  function dashToEmDash() {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode;
    const at = sel.anchorOffset;
    if (node.nodeType !== Node.TEXT_NODE || at < 2 || node.data.slice(at - 2, at) !== '--') return;
    const r = document.createRange();
    r.setStart(node, at - 2);
    r.setEnd(node, at);
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand('insertText', false, '—');
  }

  // Pressing Enter on an empty line that follows a paragraph of text makes a scene break.
  const blockOf = (node) => {
    let n = node && (node.nodeType === 1 ? node : node.parentElement);
    while (n && n !== editor && n.parentElement !== editor) n = n.parentElement;
    return n === editor ? null : n;
  };
  function sceneBreak(block) {
    const r = document.createRange();
    r.selectNode(block);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('insertHTML', false, '<hr><p><br></p>');
  }

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const sel = getSelection();
      const block = sel.rangeCount && sel.isCollapsed ? blockOf(sel.anchorNode) : null;
      const prev = block && block.previousElementSibling;
      if (block && block.tagName === 'P' && !block.textContent && !block.querySelector('img') &&
          prev && prev.tagName === 'P' && prev.textContent.trim()) {
        e.preventDefault();
        sceneBreak(block);
        return;
      }
    }
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const inList = getSelection().anchorNode?.parentElement?.closest('li');
    if (inList) document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    else if (!e.shiftKey) document.execCommand('insertText', false, '\t');
  });

  // ---- paste: keep simple formatting, drop everything else -------------------
  const KEEP = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'B', 'I', 'U', 'S', 'SUB', 'SUP', 'A']);
  const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'LI']);
  const RENAME = { STRONG: 'B', EM: 'I', STRIKE: 'S', DEL: 'S', DIV: 'P', SECTION: 'P', ARTICLE: 'P', H4: 'H3', H5: 'H3', H6: 'H3' };
  const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'TITLE', 'HEAD', 'LINK', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
    'SVG', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);

  function cleanInto(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) { parent.append(node.nodeValue.replace(/\u00a0/g, ' ')); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || DROP.has(node.tagName)) return;
    const tag = RENAME[node.tagName] || node.tagName;
    const st = node.style;
    let holder = parent;
    if (KEEP.has(tag)) {
      if (tag === 'A') {
        const href = safeUrl(node.getAttribute('href'));
        if (href) { const a = document.createElement('a'); a.setAttribute('href', href); parent.append(a); holder = a; }
      } else {
        const el = document.createElement(tag.toLowerCase());
        if (st && BLOCK.has(tag) && /^(left|center|right|justify)$/.test(st.textAlign)) el.style.textAlign = st.textAlign;
        parent.append(el);
        holder = el;
      }
    }
    if (st) {
      const deco = st.textDecorationLine || st.textDecoration || '';
      const wraps = [];
      if (/^(bold|[6-9]00)$/.test(st.fontWeight) && tag !== 'B') wraps.push('b');
      if (st.fontStyle === 'italic' && tag !== 'I') wraps.push('i');
      if (deco.includes('underline') && tag !== 'U') wraps.push('u');
      if (deco.includes('line-through') && tag !== 'S') wraps.push('s');
      for (const w of wraps) { const el = document.createElement(w); holder.append(el); holder = el; }
    }
    for (const child of node.childNodes) cleanInto(child, holder);
  }

  function sanitize(html) {
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    const out = document.createElement('div');
    for (const child of body.childNodes) cleanInto(child, out);
    return out.textContent.trim() || out.querySelector('br') ? out.innerHTML : '';
  }

  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const clean = html ? sanitize(html) : '';
    document.execCommand('styleWithCSS', false, false);
    if (clean) document.execCommand('insertHTML', false, clean);
    else document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  // ---- menu actions --------------------------------------------------------
  emw.actions.undo = () => { editor.focus(); document.execCommand('undo'); };
  emw.actions.redo = () => { editor.focus(); document.execCommand('redo'); };
  emw.actions.selectAll = () => { editor.focus(); document.execCommand('selectAll'); };

  // An empty page starts with the writer's default font, size and spacing (Settings > Writing).
  // They go on the first paragraph only, so text that already exists is never restyled, and a
  // later change to the defaults affects new text only. With the stock defaults nothing is added.
  function blankHtml() {
    const S = emw.settings;
    const p = document.createElement('p');
    if (S) {
      const font = String(S.get('writingFont') || '').replace(/["\\;{}]/g, '');
      const size = S.get('writingSize');
      const lh = S.get('writingSpacing');
      if (font) p.style.fontFamily = `"${font}", serif`;
      if (size && size !== 18) p.style.fontSize = size + 'px';
      if (lh && lh !== 1.75) p.style.lineHeight = String(lh);
    }
    p.append(document.createElement('br'));
    return p.outerHTML;
  }

  // ---- API for app.js ------------------------------------------------------
  emw.editor = {
    onChange: (cb) => editor.addEventListener('input', cb),
    html: () => editor.innerHTML,
    text: () => editor.innerText,
    focus: () => editor.focus(),
    exec,        // shared with auto-highlight.js so it gets restore() and styleWithCSS
    inEditor,
    load(html) {
      editor.contentEditable = 'false';
      editor.innerHTML = html || blankHtml();
      editor.contentEditable = 'true';
      savedRange = null;
      pendingSize = null;
      page.scrollTop = 0;
      updateEmpty();
    }
  };

  emw.sanitize = sanitize;
  emw.safeUrl = safeUrl;

  // ---- typewriter mode: the line you are writing stays near the middle of the page ----------
  let typewriter = false;
  const twBtn = $('#rb-typewriter');
  function centerCaret() {
    if (!typewriter || !inEditor()) return;
    const sel = getSelection();
    let rect = sel.getRangeAt(0).getClientRects()[0];
    if (!rect) {
      const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      rect = node.getBoundingClientRect();
    }
    const box = page.getBoundingClientRect();
    const delta = rect.top - (box.top + box.height * 0.45);
    if (Math.abs(delta) > 3) page.scrollTop += delta;
  }
  function setTypewriter(on) {
    typewriter = on;
    editor.classList.toggle('typewriter', on);
    twBtn.setAttribute('aria-pressed', String(on));
    if (on) centerCaret();
  }
  // The ribbon button and Settings > Writing share one saved value (settings.json).
  twBtn.addEventListener('click', () => {
    setTypewriter(!typewriter);
    if (emw.settings) emw.settings.set('typewriter', typewriter);
    editor.focus();
  });
  editor.addEventListener('keyup', (e) => {
    if (typewriter && /^(Arrow|Page|Home|End|Enter|Backspace|Delete)/.test(e.key)) centerCaret();
  });
  // Before part 5d this was remembered in localStorage. Carry an "on" over once, then drop the key.
  try {
    const old = localStorage.getItem('emwriter.typewriter');
    if (old !== null) {
      localStorage.removeItem('emwriter.typewriter');
      if (old === '1' && emw.settings && !emw.settings.get('typewriter')) emw.settings.set('typewriter', true);
    }
  } catch { /* ignore */ }
  if (emw.settings) {
    setTypewriter(!!emw.settings.get('typewriter'));
    emw.settings.onChange((key, value) => { if (key === 'typewriter' && !!value !== typewriter) setTypewriter(!!value); });
  }

  // ---- drop cap: settings live on the chapter, the app tells us what to show ------------------
  const dcBtn = $('#rb-dropcap');
  const dcFont = $('#rb-dc-font');
  const dcLines = $('#rb-dc-lines');
  const dcGap = $('#rb-dc-gap');
  const dcColor = $('#rb-dc-color');
  const dcSwatch = $('#sw-dc');
  const dcReset = $('#rb-dc-reset');
  const dcEdit = (patch) => { if (emw.editor.onDropcapEdit) emw.editor.onDropcapEdit(patch); };
  let dcExplicit = false;
  const dcStart = () => (emw.legibility ? emw.legibility.accentHex() : '#e8caa4');
  // A chapter with no drop cap colour follows the theme and accent; one with a colour keeps it.
  document.documentElement.addEventListener('emw:themechange', () => { if (!dcExplicit) dcColor.value = dcStart(); });

  dcBtn.addEventListener('click', () => dcEdit({ on: dcBtn.getAttribute('aria-pressed') !== 'true' }));
  emw.fontPicker(dcFont, { onPick: (name) => dcEdit({ font: name }) });
  dcLines.addEventListener('change', () => dcEdit({ lines: Number(dcLines.value) }));
  dcGap.addEventListener('input', () => dcEdit({ gap: Math.max(0, Math.min(40, Number(dcGap.value) || 0)) }));
  dcColor.addEventListener('input', () => dcEdit({ color: dcColor.value }));
  dcReset.addEventListener('click', () => dcEdit({ font: '', lines: 3, gap: 8, color: '' }));

  emw.editor.syncDropcap = (settings, active) => {
    const dc = Object.assign({ on: false, font: '', lines: 3, gap: 8, color: '' }, settings);
    dcBtn.setAttribute('aria-pressed', String(dc.on));
    for (const c of [dcFont, dcLines, dcGap, dcColor, dcReset]) c.disabled = !dc.on;
    dcFont.querySelector('.fp-label').textContent = dc.font || 'Same as text';
    if (document.activeElement !== dcLines) dcLines.value = String(dc.lines);
    if (document.activeElement !== dcGap) dcGap.value = String(dc.gap);
    // No colour of its own: the cap takes the text colour, and the picker starts from the theme's accent.
    dcExplicit = !!dc.color;
    dcColor.value = dc.color || dcStart();
    dcSwatch.style.setProperty('--c', dc.color || 'var(--ink)');
    editor.classList.toggle('dc-on', dc.on && active);
    editor.style.setProperty('--dc-lines', dc.lines);
    editor.style.setProperty('--dc-gap', dc.gap + 'px');
    editor.style.setProperty('--dc-font', dc.font ? `"${dc.font}"` : 'inherit');
    editor.style.setProperty('--dc-color', dc.color || 'inherit');
    dcBtn.title = dc.on && !active
      ? 'Drop cap is on for this chapter. It shows on the chapter’s first paragraph, which is in another scene.'
      : 'Drop cap on the first paragraph of this chapter';
  };
})();
