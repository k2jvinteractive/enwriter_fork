// Part 5e: the Library section of Settings, and the flow for moving to, starting, or opening a
// library in another folder. The main process does all the work and the checks; this file only
// asks questions and reports. The renderer never sees or builds a path for the action itself: it
// asks for a folder dialog, then names one of three actions.
(() => {
  'use strict';
  const emw = window.emw;
  const st = emw.settings;
  if (!st || !st.ui) return;
  const { el, row } = st.ui;

  // Error text from the main process arrives wrapped by Electron; show only the sentence.
  const plain = (err, fallback) => (err && err.message ? String(err.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : '') || fallback;

  // ---- the question dialog ------------------------------------------------------------------
  // One small dialog, used for the three-way choice, for progress, and for plain messages.
  let dlg = null, body = null;
  function ensureDialog() {
    if (dlg) return;
    dlg = el('dialog', 'lib-choice');
    dlg.setAttribute('aria-label', 'Change library location');
    body = el('div', 'lc-body');
    dlg.append(body);
    document.body.append(dlg);
  }

  // Resolves with the chosen mode, or null for Cancel, Escape and a click outside.
  function askChoice(found) {
    ensureDialog();
    return new Promise((resolve) => {
      body.textContent = '';
      body.append(el('h3', null, 'Use this folder for your library?'));
      const where = el('p', 'lc-path', found.path);
      body.append(where);
      const hasLib = found.kind === 'library';
      const what = hasLib
        ? `It already holds an emWriter library: ${count(found.books, 'book')} on ${count(found.shelves, 'shelf', 'shelves')}.`
        : found.kind === 'empty' ? 'The folder is empty.' : 'The folder has other files in it. emWriter will not touch them.';
      body.append(el('p', 'lc-what', what));

      const opts = [
        ['move', 'Move my books here', 'Copies every book here, checks each copy, then moves the originals to the trash. If anything fails, nothing is moved.',
          hasLib ? 'That folder already holds a library, so books cannot be moved into it.' : ''],
        ['fresh', 'Start a new library here', 'Starts empty. Your current books stay where they are, and you can open that library again later.',
          hasLib ? 'That folder already holds a library. Open it instead.' : ''],
        ['open', 'Open the library in this folder', 'Shows the shelves and books that are already there.',
          hasLib ? '' : 'There is no emWriter library in that folder.']
      ];
      const list = el('div', 'lc-opts');
      for (const [mode, title, desc, why] of opts) {
        const b = el('button', 'lc-opt');
        b.type = 'button';
        b.disabled = !!why;
        b.append(el('b', null, title), el('span', null, why || desc));
        b.addEventListener('click', () => finish(mode));
        list.append(b);
      }
      body.append(list);
      const foot = el('div', 'dialog-actions');
      const cancel = el('button', 'quiet', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => finish(null));
      foot.append(cancel);
      body.append(foot);

      let done = false;
      function finish(v) { if (done) return; done = true; dlg.removeEventListener('cancel', onCancel); dlg.removeEventListener('click', onBackdrop); resolve(v); }
      const onCancel = () => finish(null);
      const onBackdrop = (e) => { if (e.target === dlg) { dlg.close(); finish(null); } };
      dlg.addEventListener('cancel', onCancel);
      dlg.addEventListener('click', onBackdrop);
      if (!dlg.open) dlg.showModal();
      (list.querySelector('button:not(:disabled)') || cancel).focus();
    });
  }

  function working(text) {
    ensureDialog();
    body.textContent = '';
    body.append(el('h3', null, text), el('p', 'lc-what', 'Please keep emWriter open.'));
    // No way out while files are being copied.
    dlg.addEventListener('cancel', (e) => e.preventDefault(), { once: true });
    if (!dlg.open) dlg.showModal();
  }

  function message(title, lines) {
    ensureDialog();
    return new Promise((resolve) => {
      body.textContent = '';
      body.append(el('h3', null, title));
      for (const l of [].concat(lines)) body.append(el('p', 'lc-what', l));
      const foot = el('div', 'dialog-actions');
      const ok = el('button', null, 'OK');
      ok.type = 'button';
      ok.addEventListener('click', () => dlg.close());
      foot.append(ok);
      body.append(foot);
      dlg.addEventListener('close', resolve, { once: true });
      if (!dlg.open) dlg.showModal();
      ok.focus();
    });
  }

  function count(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  // ---- the flow -------------------------------------------------------------------------------
  let busy = false;
  async function change(redo) {
    if (busy) return;
    busy = true;
    try {
      let picked = null;
      try { picked = await window.api.chooseLibraryFolder(); }
      catch (err) { await message('Could not open the folder chooser', plain(err, 'Try again.')); return; }
      if (!picked) return;   // cancelled: nothing changed

      let found;
      try { found = await window.api.inspectLibraryFolder(); }
      catch (err) { await message('That folder will not work', plain(err, 'Choose a different folder.')); return; }

      const mode = await askChoice(found);
      if (!mode) { if (dlg.open) dlg.close(); return; }

      // Leave the open book first: its pending text is saved, and nothing writes to the library
      // while it is being copied or switched.
      working(mode === 'move' ? 'Moving your books…' : 'Switching library…');
      try { if (emw.book && emw.book.id) await emw.book.close(); } catch { /* the main process re-checks everything */ }

      let result;
      try { result = await window.api.applyLibraryFolder(mode); }
      catch (err) {
        dlg.close();
        await message('Nothing was changed', plain(err, 'The library could not be changed. Your books are where they were.'));
        await emw.home.refresh();
        redo();
        return;
      }
      dlg.close();
      emw.showView('home');
      await emw.home.refresh();
      redo();
      const lines = [{ move: `${count(result.moved, 'book')} moved to ${result.path}.`, fresh: `A new, empty library is ready in ${result.path}. Your old books are still where they were.`, open: `Opened the library in ${result.path}.` }[mode]];
      if (result.notes && result.notes.length) {
        await message('Done, with a note', [lines[0], ...result.notes, 'The extra copies are safe to delete by hand.']);
      } else emw.toast(lines[0], { ms: 8000 });
    } finally {
      busy = false;
      if (dlg && dlg.open && !dlg.querySelector('button')) dlg.close();
    }
  }

  // ---- the section ----------------------------------------------------------------------------------
  st.addSection({
    id: 'library', label: 'Library',
    render(pane, redo) {
      pane.append(el('h2', null, 'Library'));

      const pathText = el('p', 'st-libpath', 'Looking…');
      const counts = el('p', 'st-hint', '');
      const change_ = el('button', null, 'Change…');
      change_.type = 'button';
      change_.addEventListener('click', () => change(redo));
      const show = el('button', null, 'Show in folder');
      show.type = 'button';
      show.addEventListener('click', () => { window.api.revealLibrary().catch(() => emw.toast('Could not open that folder.')); });
      const btns = el('div', 'st-inline');
      btns.append(change_, show);

      const box = el('div', 'st-libbox');
      box.append(pathText, counts, btns);
      pane.append(row('Location', box, 'Every book is a .mwt folder inside this folder, next to library.json. Back it up by copying the whole folder.'));

      window.api.libraryInfo().then((i) => {
        pathText.textContent = i.path;
        counts.textContent = `${count(i.books, 'book')} on ${count(i.shelves, 'shelf', 'shelves')}`;
      }).catch(() => { pathText.textContent = 'Could not read the library.'; });
    }
  });
})();
