// Part 7c: the custom dictionary and the Spelling rows of Settings > Writing.
//
// The list lives in settings.json (customWords) and is shared by all books. main.js makes the
// session's dictionary match it and cleans it again, so the rules below only give quick feedback;
// they are the same as in library.js (sanitiseWords): 1 to 60 characters, letters (any script, so
// accented names work), apostrophes and hyphens, unique ignoring case, at most 5000 words.
(() => {
  'use strict';
  const emw = window.emw;
  const st = emw.settings;
  if (!st || !st.ui || !st.extend) return;
  const { el, row, segmented } = st.ui;

  const MAX_WORDS = 5000;
  const MAX_LENGTH = 60;
  const SHOW_AT_MOST = 400;
  const WORD_RE = /^[\p{L}\p{M}'-]+$/u;
  const HAS_LETTER = /\p{L}/u;

  // A curly apostrophe is stored straight: smart quotes curl them while typing, and the checker
  // treats both alike.
  const clean = (raw) => {
    const w = String(raw).trim().replace(/\u2019/g, "'");
    return w.length >= 1 && w.length <= MAX_LENGTH && WORD_RE.test(w) && HAS_LETTER.test(w) ? w : '';
  };
  const key = (w) => w.toLocaleLowerCase();
  const words = () => (Array.isArray(st.get('customWords')) ? st.get('customWords') : []);
  const count = (n) => `${n} ${n === 1 ? 'word' : 'words'}`;

  // Save now rather than after the 300 ms debounce, so main updates the checker straight away, then
  // ask the focused field to check itself again so an underline goes at once.
  function save(next) {
    st.set('customWords', next);
    const again = () => { try { if (emw.spell && emw.spell.recheck) emw.spell.recheck(); } catch { /* the underline goes on the next edit */ } };
    Promise.resolve(st.flush()).then(again, again);
  }

  // Adds what is valid and new. Answers what happened to each word so the caller can say so.
  function add(list) {
    const next = words().slice();
    const seen = new Set(next.map(key));
    const out = { added: [], duplicates: 0, rejected: [], full: false };
    for (const raw of list) {
      const w = clean(raw);
      if (!w) { out.rejected.push(String(raw)); continue; }
      if (seen.has(key(w))) { out.duplicates++; continue; }
      if (next.length >= MAX_WORDS) { out.full = true; continue; }
      seen.add(key(w));
      next.push(w);
      out.added.push(w);
    }
    if (out.added.length) save(next);
    return out;
  }

  function remove(list) {
    const gone = new Set(list.map(key));
    const before = words();
    const removed = before.filter((w) => gone.has(key(w)));
    if (removed.length) save(before.filter((w) => !gone.has(key(w))));
    return removed;
  }

  // Undo puts back only the words that were removed, so anything added since stays.
  const undoRemove = (removed) => ({ label: 'Undo', run: () => { add(removed); } });

  // ---- the spell context menu: "Add to dictionary" -----------------------------------------------
  function addWord(raw) {
    const w = clean(raw);
    if (!w) {
      emw.toast('That word cannot go in the dictionary. Words can have letters, apostrophes and hyphens only.');
      return;
    }
    const r = add([w]);
    if (r.added.length) emw.toast(`Added “${w}” to your dictionary.`, { action: { label: 'Undo', run: () => { remove(r.added); } } });
    else if (r.full) emw.toast(`Your dictionary is full (${MAX_WORDS} words). Remove some in Settings > Writing.`);
    else emw.toast(`“${w}” is already in your dictionary.`);
  }
  emw.spell = { ...(emw.spell || {}), addWord };

  // ---- Settings > Writing --------------------------------------------------------------------------
  let repaint = null;   // redraws the open list; replaced each time the section is drawn
  st.onChange((k) => { if (k === 'customWords' && repaint) repaint(); });

  st.extend('writing', (pane, redo) => {
    const anchor = pane.querySelector('.st-reset');   // "Reset to default" stays last
    const put = (n) => (anchor ? pane.insertBefore(n, anchor) : pane.append(n));

    // -- language ---------------------------------------------------------------------------------
    put(el('h3', 'st-sub', 'Spelling'));
    if (emw.spell.isSystem && emw.spell.isSystem()) {
      put(row('Language', el('span', null, 'Chosen by your system'),
        'On macOS the system spell checker decides the language. Change it in your system settings.'));
    } else {
      const langs = segmented('st-spelllang', emw.SPELL_LANGUAGES.map((l) => [l.label, l.id]), st.get('spellLanguage'), (id) => {
        // The dictionary may have to download first; if it cannot, the choice goes back to what it was.
        if (!emw.spell.chooseDefault) { st.set('spellLanguage', id); return; }
        Promise.resolve(emw.spell.chooseDefault(id)).then((ok) => { if (!ok) redo(); }, () => redo());
      });
      put(row('Language', langs, 'The default for all books. A book can use its own from the language button on the ribbon.'));
    }

    // -- dictionary ------------------------------------------------------------------------------------
    put(el('h3', 'st-sub', 'Dictionary'));

    const input = el('textarea');
    input.rows = 1;
    input.spellcheck = false;   // names are exactly what does not belong in a spell checked field
    input.placeholder = 'Add a word and press Enter';
    input.setAttribute('aria-label', 'Words to add to the dictionary');
    const addBtn = el('button', null, 'Add');
    addBtn.type = 'button';
    const status = el('output', 'st-hint');   // an <output> is a live region
    const adder = el('div', 'st-dict-add');
    adder.append(input, addBtn);

    function submit() {
      // Commas, spaces and new lines all separate words, so a pasted list just works.
      const parts = input.value.split(/[\s,;]+/).filter(Boolean);
      if (!parts.length) return;
      const r = add(parts);
      const bits = [];
      if (r.added.length) bits.push(`Added ${count(r.added.length)}.`);
      if (r.duplicates) bits.push(`${r.duplicates} already in the list.`);
      if (r.rejected.length) {
        const shown = r.rejected.slice(0, 3).map((w) => (w.length > 20 ? w.slice(0, 20) + '…' : w)).join(', ');
        bits.push(`Left out ${r.rejected.length}: ${shown}${r.rejected.length > 3 ? '…' : ''}. Words can have letters, apostrophes and hyphens only.`);
      }
      if (r.full) bits.push(`The dictionary is full (${MAX_WORDS} words).`);
      status.textContent = bits.join(' ');
      input.value = r.rejected.join(' ');   // only what could not be added stays, to fix
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    addBtn.addEventListener('click', () => { submit(); input.focus(); });
    const addRow = row('Add words', adder, 'Separate several words with commas, spaces or new lines.');
    addRow.append(status);
    put(addRow);

    const filter = el('input');
    filter.type = 'text';
    filter.placeholder = 'Filter words';
    filter.setAttribute('aria-label', 'Filter the dictionary');
    filter.spellcheck = false;
    const total = el('span', 'st-hint');
    total.setAttribute('role', 'status');
    const head = el('div', 'st-inline');
    head.append(filter, total);
    const list = el('ul', 'st-words');
    list.setAttribute('aria-label', 'Words in your dictionary');
    const more = el('p', 'st-hint');

    function chip(w) {
      const li = el('li', 'chip');
      const x = el('button', 'chip-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${w} from the dictionary`);
      x.addEventListener('click', () => {
        const removed = remove([w]);
        if (removed.length) emw.toast(`Removed “${w}” from your dictionary.`, { action: undoRemove(removed) });
      });
      li.append(el('span', 'chip-label', w), x);
      return li;
    }

    function paintList() {
      if (!list.isConnected) return;   // the section was redrawn or closed
      const all = words();
      const q = filter.value.trim().toLocaleLowerCase();
      const hits = (q ? all.filter((w) => key(w).includes(q)) : all.slice()).sort((a, b) => a.localeCompare(b));
      total.textContent = q ? `${hits.length} of ${count(all.length)}` : count(all.length);
      list.replaceChildren(...hits.slice(0, SHOW_AT_MOST).map(chip));
      more.textContent = hits.length ? `Showing the first ${SHOW_AT_MOST}. Type in the filter to find the rest.`
        : (all.length ? 'No word matches that filter.' : 'No words yet.');
      more.hidden = hits.length <= SHOW_AT_MOST && hits.length > 0;
    }
    filter.addEventListener('input', paintList);
    repaint = paintList;

    const box = el('div', 'st-dict');
    box.append(head, list, more);
    put(row('Your words', box, 'Shared by all books. Words you add here are accepted in every book, with spell check on or off.'));
    paintList();
  });
})();
