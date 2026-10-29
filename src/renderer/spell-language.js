// Part 7c: the spell check language. US or UK English, set for every book in Settings and optionally
// overridden by one book (stored in book.json as spellLanguage, changed through the store so it is one
// undo step). The ribbon shows a small US/UK button beside the spell check button; it opens a menu.
//
// Who does what: main.js owns the checker and answers { ok, language } once the dictionary is really
// loaded (Windows and Linux may download it first). This file decides which language *should* be in
// force (the book's, else the default) and keeps the two in step. If a language cannot be loaded the
// checker keeps the previous one, a toast says so, and the control shows the language actually in use.
// On macOS the system checker chooses the language, so the control is hidden.
(() => {
  'use strict';
  const emw = window.emw;
  const st = emw.settings;
  const S = emw.store;
  const LANGS = emw.SPELL_LANGUAGES;
  const button = document.getElementById('rb-spell-lang');
  if (!st || !S || !LANGS || !window.api || !window.api.spellSetLanguage) return;

  const byId = (id) => LANGS.find((l) => l.id === id) || null;
  const bookOpen = () => !!(emw.book && emw.book.id);
  const bookLang = () => (bookOpen() && S.data && byId(S.data.spellLanguage) ? S.data.spellLanguage : null);
  const defaultLang = () => (byId(st.get('spellLanguage')) ? st.get('spellLanguage') : LANGS[0].id);
  const effective = () => bookLang() || defaultLang();

  let system = false;      // macOS: the system checker picks the language
  let applied = null;      // the language the checker is really using, as main last reported it
  let busy = false;        // a change is being applied; one at a time
  let again = false;       // something changed while busy; look again afterwards
  let failedFor = null;    // a wanted language that would not load; not retried until something changes
  let scope = 'book';      // what the menu's next pick applies to: 'book' or 'all'

  const spellOn = () => st.get('spellcheck') === true;
  const failToast = (id) => {
    const l = byId(id);
    emw.toast(`Could not load the ${l ? l.label : 'selected'} dictionary. Check your connection and try again.`, { ms: 8000 });
  };

  // ---- the ribbon button ----------------------------------------------------------------------
  function paint() {
    if (!button) return;
    button.hidden = system;
    const l = byId(applied) || byId(effective());
    button.textContent = l ? l.short : '';
    const k = emw.keys && emw.keys.display('spellLanguage');
    button.title = 'Spell check language: ' + (l ? l.label : '') + (k ? ` (${k})` : '');
    button.setAttribute('aria-label', 'Spell check language, ' + (l ? l.label : ''));
  }

  // Ask main for a language and wait for the dictionary. Never throws.
  async function apply(id) {
    try {
      const r = await window.api.spellSetLanguage(id);
      if (r && byId(r.language)) applied = r.language;
      return !!(r && r.ok);
    } catch { return false; }
  }

  // Make the checker match what the open book (or the default) asks for. Called whenever that could
  // have changed: a store change (undo included), another book, the default in Settings.
  async function reconcile() {
    paint();
    if (system) return;
    const want = effective();
    if (failedFor && want !== failedFor) failedFor = null;
    if (want === applied || want === failedFor) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      if (!(await apply(want))) {
        failedFor = want;                  // do not hammer a download that is failing
        if (spellOn()) failToast(want);    // with spell check off nobody is waiting for it
      }
    } finally { busy = false; paint(); }
    if (again) { again = false; reconcile(); }
  }

  // A pick from the menu. The checker is changed first and the book or setting only if that worked, so
  // a failed download leaves nothing half changed and the control stays on the previous language.
  async function choose(id, which) {
    if (system || !byId(id)) return;
    if (busy) { emw.toast('Still loading a dictionary. Try again in a moment.'); return; }
    busy = true;
    let ok = false;
    try { ok = await apply(id); } finally { busy = false; }
    if (!ok) { failToast(id); paint(); return; }
    failedFor = null;
    const l = byId(id);
    if (which === 'all' || !bookOpen()) {
      const prevDefault = defaultLang();
      const prevBook = bookLang();
      const bookWas = emw.book.id;
      if (prevBook) S.setSpellLanguage(null);   // the book follows the default again
      st.set('spellLanguage', id);
      emw.toast(`Spell check: ${l.label} for all books.`, { action: { label: 'Undo', run: () => {
        st.set('spellLanguage', prevDefault);
        if (prevBook && emw.book.id === bookWas) S.setSpellLanguage(prevBook);
      } } });
    } else {
      const prev = bookLang();
      const bookWas = emw.book.id;
      S.setSpellLanguage(id);
      emw.toast(`Spell check: ${l.label} for this book.`, { action: { label: 'Undo', run: () => {
        if (emw.book.id === bookWas) S.setSpellLanguage(prev);
      } } });
    }
    reconcile();
  }

  // The default language, from Settings. If this book has its own language the default does not change
  // anything that is showing, so it is just saved; otherwise the dictionary has to load first.
  async function chooseDefault(id) {
    if (system || !byId(id)) return false;
    if (bookLang() || id === applied) { st.set('spellLanguage', id); return true; }
    if (busy) { emw.toast('Still loading a dictionary. Try again in a moment.'); return false; }
    busy = true;
    let ok = false;
    try { ok = await apply(id); } finally { busy = false; }
    if (!ok) { failToast(id); paint(); return false; }
    failedFor = null;
    st.set('spellLanguage', id);
    reconcile();
    return true;
  }

  // ---- the menu ---------------------------------------------------------------------------------
  function openMenu() {
    if (system) return;
    if (!bookOpen()) scope = 'all';
    const r = button && button.getBoundingClientRect();
    const x = r && r.width ? r.left : innerWidth / 2;
    const y = r && r.height ? r.bottom + 4 : innerHeight / 3;
    const now = applied || effective();
    const items = LANGS.map((l) => ({ label: l.label, checked: l.id === now, run: () => choose(l.id, scope) }));
    items.push(
      null,
      { label: 'Use for this book', checked: scope === 'book' && bookOpen(), disabled: !bookOpen(), run: () => { scope = 'book'; openMenu(); } },
      { label: 'Use for all books', checked: scope === 'all' || !bookOpen(), run: () => { scope = 'all'; openMenu(); } }
    );
    emw.menu(x, y, items);
  }

  if (button) button.addEventListener('click', openMenu);
  emw.actions.spellLanguage = openMenu;
  if (emw.keys) {
    emw.keys.register({ id: 'spellLanguage', label: 'Spell check language', group: 'Writing' });
    emw.keys.onChange(paint);
  }

  // ---- download progress ----------------------------------------------------------------------------
  try {
    window.api.onSpellDownload(({ state, language }) => {
      const l = byId(language);
      if (!l) return;
      if (state === 'begin' && (busy || spellOn())) emw.toast(`Loading the ${l.label} dictionary…`);
      // A failure while a change is running is reported by that change. This catches the others,
      // such as the first dictionary at start-up.
      if (state === 'failure' && !busy && spellOn()) failToast(language);
    });
  } catch { /* no bridge: the answers to spellSetLanguage still report failures */ }

  // ---- keeping in step -------------------------------------------------------------------------------
  S.on(reconcile);                                   // includes undo and redo
  emw.book.onSwitch(() => { failedFor = null; reconcile(); });
  st.onChange((key) => {
    if (key === 'spellLanguage') reconcile();
    if (key === 'spellcheck' && spellOn()) { failedFor = null; reconcile(); }   // turning it on is a reason to try again
  });

  emw.spell = {
    ...(emw.spell || {}),
    isSystem: () => system,
    language: () => applied || effective(),
    chooseDefault
  };

  paint();
  Promise.resolve(window.api.spellInfo()).then((info) => {
    system = !!(info && info.system);
    if (info && byId(info.language)) applied = info.language;
    reconcile();
  }, () => reconcile());
})();
