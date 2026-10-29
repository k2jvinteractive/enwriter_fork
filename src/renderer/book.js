// The open book: which one it is, per-book storage keys, and switching between books.
// Loads right after settings.js and before store.js. It only touches emw.store when a switch
// actually happens, so the load order does not matter for that.
//
// A switch is the one place that has to get the order right:
//   1. save everything pending in the OLD book (editor text, index, note bodies, settings),
//   2. tell the main process to open the new one and read it,
//   3. reset the store (which also drops undo history), then let every view reset and re-render.
// Nothing is written after step 1 until step 3 is finished, so text can never land in the wrong book.
(() => {
  'use strict';
  const emw = window.emw;

  let id = null;
  let busy = false;
  let upgraded = false;
  const listeners = [];

  const failSafe = async (fn) => { try { await fn(); } catch { /* one failing hook must not block the switch */ } };

  // Everything that writes to the currently open book, finished before we leave it.
  async function settle() {
    await failSafe(() => emw.actions.flush && emw.actions.flush());
    for (const f of emw.flushHooks) await failSafe(f);
  }

  async function announce() {
    for (const cb of listeners) await failSafe(() => cb(id));
    if (emw.refreshTabs) emw.refreshTabs();
    document.dispatchEvent(new CustomEvent('emw:book'));
  }

  const book = {
    get id() { return id; },
    get title() { return (emw.store && emw.store.data && emw.store.data.title) || ''; },
    // true when loading the book had to upgrade its data (so the caller knows it is worth saving)
    get upgraded() { return upgraded; },
    // Per-book UI state in localStorage: emwriter.<name>.<bookId>
    key: (name) => `emwriter.${name}.${id || 'none'}`,
    // cb(bookId|null) runs after the store has been reset for the new book (null = no book open)
    onSwitch: (cb) => { listeners.push(cb); },

    async open(newId) {
      if (busy) return false;
      if (typeof newId !== 'string' || !newId) return false;
      busy = true;
      const previous = id;
      let mainSwitched = false;
      try {
        await settle();
        await window.api.openBook(newId);
        mainSwitched = true;
        const raw = await window.api.loadNovel();
        // load() fixes the data in place, so compare before and after to see if it was upgraded.
        const before = JSON.stringify(raw);
        emw.store.load(raw);
        upgraded = JSON.stringify(emw.store.data) !== before;
        id = newId;
      } catch (err) {
        // The main process may already point at the new book while we still show the old one.
        // Put it back, or later saves would go to the wrong book.
        if (mainSwitched) {
          try { if (previous) await window.api.openBook(previous); else await window.api.closeBook(); } catch { /* nothing more to do */ }
        }
        busy = false;
        const msg = err && err.message ? String(err.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : '';
        emw.toast(msg || 'Could not open that book. Nothing was changed.', { ms: 8000 });
        return false;
      }
      try { await announce(); } finally { busy = false; }
      return true;
    },

    // Leave the book (Home with nothing open). The store gets an empty placeholder so views
    // that read it never meet null; nothing is ever saved while id is null.
    async close() {
      if (busy) return false;
      busy = true;
      try {
        await settle();
        try { await window.api.closeBook(); } catch { /* ignore */ }
        emw.store.load({});
        upgraded = false;
        id = null;
        await announce();
      } finally { busy = false; }
      return true;
    },

    // The open book was renamed from outside the editor (Home). The file on disk already has the
    // new title; keep our copy in step or the next index save would write the old one back.
    renamed(newTitle) {
      if (!id || !emw.store.data) return;
      emw.store.data.title = newTitle;
      const box = document.getElementById('novel-title');
      if (box) box.value = newTitle;
    }
  };

  emw.book = book;
})();
