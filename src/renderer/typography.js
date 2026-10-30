// Page font and size (part 7f). The ribbon's font and size controls change the whole book at once:
// the choice is stored in book.json (`typography`, through the store, so it is undoable) and shown by two CSS
// variables, --page-font and --page-size. Nothing is written into the text, so choosing a font never touches a
// scene file. The drop cap keeps its own font (--dc-font) and line spacing keeps coming from `writingSpacing`.
//
// Text that already carries its own font-family or font-size (older books) is left alone. When the writer changes
// the page font and the open scene has such text, a toast offers Reset, which takes a safety snapshot first.
(() => {
  'use strict';
  const emw = window.emw;
  const S = emw.store;
  const st = emw.settings;
  const fontBtn = document.getElementById('rb-font');
  const sizeSel = document.getElementById('rb-size');
  const centerEl = document.querySelector('.center');   // holds the page and the chapter overview
  if (!fontBtn || !sizeSel || !centerEl) return;
  const label = fontBtn.querySelector('.fp-label');
  const editorEl = document.getElementById('editor');
  const failSafe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  // ---- what is in force ----------------------------------------------------------------------------
  // The book's own choice wins; empty falls back to the app-wide default in Settings > Writing.
  const own = () => (S.data ? S.typography() : { font: '', size: null });
  const effective = () => {
    const t = own();
    const font = t.font || failSafe(() => st.get('writingFont'), '') || '';
    const n = Number(t.size || failSafe(() => st.get('writingSize'), 18));
    return { font, size: n >= 8 && n <= 96 ? n : 18 };
  };
  const cssFont = (name) => (name ? `"${String(name).replace(/["\\]/g, '')}", var(--serif)` : '');

  let previewing = null;   // a font name while the picker is browsing, else null

  function apply() {
    const e = effective();
    const font = previewing !== null ? previewing : e.font;
    if (font) centerEl.style.setProperty('--page-font', cssFont(font)); else centerEl.style.removeProperty('--page-font');
    centerEl.style.setProperty('--page-size', e.size + 'px');
    label.textContent = font || 'Default serif';
    // The size list is fixed, but a book (or a default) may hold a size that is not in it.
    if (![...sizeSel.options].some((o) => Number(o.value || o.textContent) === e.size)) {
      const o = document.createElement('option');
      o.textContent = String(e.size);
      const after = [...sizeSel.options].find((x) => Number(x.textContent) > e.size);
      sizeSel.insertBefore(o, after || null);
    }
    sizeSel.value = String(e.size);
  }

  // ---- the ribbon -----------------------------------------------------------------------------------
  const TIP = 'Applies to the whole book';
  fontBtn.title = `Font\n${TIP}`;
  sizeSel.title = `Font size\n${TIP}`;

  let toastTimer = 0;
  // Changing the page font makes no change to existing text, so tell the writer if some text has its own.
  function overridesNote(extra) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (emw.view() !== 'manuscript' || !hasOverrides(editorEl)) { if (extra) extra(); return; }
      emw.toast('Some text has its own font.', { ms: 9000, actions: [{ label: 'Reset', run: resetOwnFonts }, { label: 'Undo', run: () => S.undo() }] });
    }, 250);
  }

  emw.fontPicker(fontBtn, {
    // Cheap preview: one CSS variable, no DOM rewriting. null puts the committed font back.
    onPreview: (name) => { previewing = name; apply(); },
    onPick: (name) => {
      previewing = null;
      S.setTypography({ font: name }, { coalesce: 'typography' });
      apply();
      overridesNote(() => emw.toast(`Page font: ${name}`, { ms: 4000, action: { label: 'Undo', run: () => S.undo() } }));
    }
  });

  // Stepping through the list changes the page as it goes; each step is folded into one undo step.
  sizeSel.addEventListener('change', () => {
    S.setTypography({ size: Number(sizeSel.value) }, { coalesce: 'typography' });
    apply();
    overridesNote();
  });
  // The select must not take the editor's selection (the ribbon keeps it), and neither control uses it.

  // ---- text that has its own font -----------------------------------------------------------------------
  const OWN = '[style*="font-family"], [style*="font-size"], [style*="font:"], font[face], font[size]';
  const hasOverrides = (root) => !!root.querySelector(OWN);

  // Removes only font-family, font-size and the font shorthand. Colour, bold, italic, highlight and the rest stay.
  function stripFonts(root) {
    let changed = false;
    for (const n of [...root.querySelectorAll(OWN)]) {
      if (n.tagName === 'FONT') { n.removeAttribute('face'); n.removeAttribute('size'); changed = true; }
      if (n.style) {
        for (const p of ['font-family', 'font-size', 'font']) if (n.style.getPropertyValue(p)) { n.style.removeProperty(p); changed = true; }
        if (!n.getAttribute('style')) n.removeAttribute('style');
      }
    }
    // Wrappers that now carry nothing are taken out, so the text does not pile up empty spans.
    for (const n of [...root.querySelectorAll('span, font')]) {
      if (n.attributes.length === 0) { n.replaceWith(...n.childNodes); changed = true; }
    }
    return changed;
  }

  let resetting = false;
  async function resetOwnFonts() {
    if (resetting || !emw.book.id) return;
    resetting = true;
    try {
      // The way back first. snapshots.js writes everything pending before it copies the book.
      const snap = emw.snapshots ? await emw.snapshots.auto('before-font-reset', 'Before font reset') : null;
      if (!snap) { emw.toast('Could not take a safety snapshot, so nothing was changed.', { ms: 7000 }); return; }
      const cur = emw.curDoc && emw.curDoc();
      const openId = cur && cur.kind === 'scene' ? cur.item.id : null;
      let scenes = 0;
      for (const ch of S.data.chapters) {
        for (const sc of ch.scenes) {
          let html = '';
          try { html = (await emw.files.read(sc.id)) || ''; } catch { continue; }
          if (!html) continue;
          const doc = new DOMParser().parseFromString(html, 'text/html');
          if (!stripFonts(doc.body)) continue;
          const out = doc.body.innerHTML;
          try { await emw.files.write(sc.id, out); } catch { continue; }
          scenes++;
          if (sc.id === openId && emw.view() === 'manuscript') emw.editor.load(out);   // show it; the file already has it
        }
      }
      emw.toast(scenes ? `Removed own fonts from ${scenes} ${scenes === 1 ? 'scene' : 'scenes'}.` : 'No scene had its own font.', {
        ms: 10000,
        action: scenes ? { label: 'Undo', run: () => emw.snapshots.restore(snap, { undo: true }) } : undefined
      });
    } catch {
      emw.toast('Could not reset the fonts. Your text was not changed.', { ms: 7000 });
    } finally { resetting = false; }
  }

  // ---- keeping in step ----------------------------------------------------------------------------------------
  // Undo and redo go through the store, so one listener covers them; so do other windows of the same book.
  S.on(() => apply());
  st.onChange((key) => { if (key === 'writingFont' || key === 'writingSize') apply(); });
  emw.book.onSwitch(() => { previewing = null; apply(); });
  document.addEventListener('emw:doc', apply);
  emw.typography = { effective, apply };
  if (S.data) apply();
})();
