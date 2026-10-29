// Keyboard shortcuts (part 7a): one registry that knows every app-level shortcut.
// Other files call emw.keys.register(...) for their actions; this file owns the single keydown
// listener, the writer's overrides (settings.json -> `shortcuts`), tab navigation, and the
// Shortcuts section of Settings where bindings are viewed and changed.
// Keys that belong to a focused control (arrows in a list, Enter on a card, Escape in a dialog)
// are NOT registered here; they stay with the control.
(() => {
  'use strict';
  const emw = window.emw;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isMac = /Mac/.test(navigator.platform);

  // ---- key grammar ------------------------------------------------------------------------------
  // Canonical form: modifiers in the order Ctrl+Alt+Shift, then one key. Letters are upper-case.
  // The same pattern guards settings.json in the main process (KEY_RE in library.js); keep them equal.
  const NAMED = ['Enter', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'];
  const PUNCT = ",./;'[]\\=`-";
  const PUNCT_CODES = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Equal: '=', Backquote: '`', Minus: '-' };
  const KEY_RE = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(?:[A-Z0-9]|[,./;'[\]\\=`-]|Enter|Tab|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Escape|F(?:[1-9]|1[0-2]))$/;
  const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Dead', 'Process'];
  const isFn = (k) => /^F([1-9]|1[0-2])$/.test(k);

  // Turns a hand-written or saved binding into canonical form, or null if it is not a valid key.
  function parse(str) {
    if (typeof str !== 'string' || !str || str.length > 60) return null;
    const parts = str.split('+').map((s) => s.trim());
    if (parts.some((p) => !p)) return null;
    const key = parts.pop();
    let ctrl = false, alt = false, shift = false;
    for (const m of parts) {
      const n = m.toLowerCase();
      if (n === 'ctrl' || n === 'control' || n === 'cmd' || n === 'command' || n === 'meta') ctrl = true;   // Cmd counts as Ctrl
      else if (n === 'alt' || n === 'option') alt = true;
      else if (n === 'shift') shift = true;
      else return null;
    }
    let k = key.length === 1 ? key.toUpperCase() : (NAMED.find((x) => x.toLowerCase() === key.toLowerCase()) || key.toUpperCase());
    if (k === ' ') k = 'Space';
    const out = (ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + k;
    return out.length <= 40 && KEY_RE.test(out) ? out : null;
  }

  // The canonical combination for a keydown, or null for a bare modifier or an unsupported key.
  function fromEvent(e) {
    if (e.isComposing || MODIFIER_KEYS.includes(e.key)) return null;
    // AltGr (Ctrl+Alt on Windows) types characters on many layouts; never treat it as a shortcut.
    try { if (e.getModifierState && e.getModifierState('AltGraph')) return null; } catch { /* ignore */ }
    const code = e.code || '';
    let k = null;
    if (/^Digit\d$/.test(code)) k = code.slice(5);              // by position: Alt+1 and Shift+1 stay "1"
    else if (e.key === ' ') k = 'Space';
    else if (e.key.length === 1) {
      if (/[a-z]/i.test(e.key)) k = e.key.toUpperCase();
      else if (/^Key[A-Z]$/.test(code)) k = code.slice(3);      // non-Latin layouts: letter by position
      else if (/\d/.test(e.key)) k = e.key;
      else if (PUNCT.includes(e.key) && !e.shiftKey) k = e.key;
      else if (PUNCT_CODES[code]) k = PUNCT_CODES[code];
    } else if (NAMED.includes(e.key) || isFn(e.key)) k = e.key;
    if (!k) return null;
    const ctrl = e.ctrlKey || (isMac && e.metaKey);
    return (ctrl ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + k;
  }

  const splitCombo = (c) => c.split('+');
  // Menus keep the existing look: "Ctrl+Shift+D", or with the Mac symbols for Ctrl and Alt.
  const menuLabel = (c) => (isMac ? c.replace('Ctrl', '⌘').replace('Alt', '⌥') : c);
  const capLabel = (part) => (isMac ? ({ Ctrl: '⌘', Alt: '⌥', Shift: '⇧' }[part] || part) : part);
  const spoken = (c) => splitCombo(c).join(' plus ');

  // ---- reserved keys ------------------------------------------------------------------------------
  // Native text editing keys, which must keep working in the editor and in every text box.
  // (Ctrl+B/I/U are editing keys of the editor too, so they are kept free as well.)
  const NATIVE = new Set(['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+Shift+V',
    'Ctrl+B', 'Ctrl+I', 'Ctrl+U']);
  const isNative = (c) => NATIVE.has(c);

  // Returns why a combination cannot be bound, or '' if it can.
  function reservedReason(c) {
    const parts = splitCombo(c);
    const key = parts[parts.length - 1];
    const ctrl = parts.includes('Ctrl'), alt = parts.includes('Alt');
    const shown = menuLabel(c);
    if (key === 'Escape' && !ctrl && !alt) return 'Escape closes menus and dialogs, so it cannot be a shortcut.';
    if (c === 'Alt+F4') return 'Alt+F4 closes the window, so it cannot be a shortcut.';
    if (key === 'F11') return 'F11 switches full screen, so it cannot be a shortcut.';
    if (NATIVE.has(c)) return `${shown} is used for editing text, so it cannot be a shortcut.`;
    if (/^(Arrow|Home$|End$)/.test(key)) return 'Arrow keys, Home and End move around in text, so they cannot be shortcuts.';
    if (ctrl && (key === 'Backspace' || key === 'Delete')) return `${shown} deletes words in text, so it cannot be a shortcut.`;
    if (!ctrl && !alt && !isFn(key)) return `A shortcut needs ${isMac ? '⌘ or ⌥' : 'Ctrl or Alt'} (only function keys can go without).`;
    return '';
  }

  // ---- the registry ---------------------------------------------------------------------------------
  const GROUPS = ['File', 'Edit', 'View', 'Navigate', 'Writing', 'Library'];
  const actions = new Map();      // id -> { id, label, group, defaults[], run, when, secret, native, scope }
  let overrides = Object.create(null);   // id -> string[]; only what the writer changed (kept even for unknown ids)
  let lookup = null;                // combo -> [action], rebuilt when anything changes
  const listeners = [];

  const bindingsOf = (a) => (hasOwn(overrides, a.id) ? overrides[a.id] : a.defaults);

  function register({ id, label, group = 'View', keys, run, when, secret = false, native = false, scope = '' }) {
    if (typeof id !== 'string' || !/^[\w.-]{1,60}$/.test(id) || id === '__proto__') { console.warn('emw.keys: bad action id', id); return; }
    const list = (Array.isArray(keys) ? keys : keys ? [keys] : []).map(parse).filter(Boolean);
    actions.set(id, {
      id, label: String(label || id), group: GROUPS.includes(group) ? group : 'View',
      defaults: [...new Set(list)], run: typeof run === 'function' ? run : () => emw.actions[id]?.(),
      when: typeof when === 'function' ? when : null, secret: !!secret, native: !!native, scope: String(scope || '')
    });
    changed(false);
  }

  function index() {
    if (lookup) return lookup;
    lookup = new Map();
    for (const a of actions.values()) {
      if (a.native) continue;
      for (const c of bindingsOf(a)) {
        if (!lookup.has(c)) lookup.set(c, []);
        lookup.get(c).push(a);
      }
    }
    return lookup;
  }

  let menuQueued = false;
  function changed(notify = true) {
    lookup = null;
    if (!menuQueued) {   // many files register at load; refresh the menu labels once afterwards
      menuQueued = true;
      queueMicrotask(() => { menuQueued = false; try { emw.refreshMenuKeys?.(); } catch { /* menus are cosmetic */ } });
    }
    if (notify) listeners.forEach((cb) => { try { cb(); } catch { /* a listener must not break the others */ } });
  }

  // Two actions may share a key only when each says it belongs to a different place
  // (Ctrl+N is "New book" on Home and "New chapter" in the manuscript).
  const clashes = (a, b) => !(a.scope && b.scope && a.scope !== b.scope);
  function conflicts(combo, id) {
    const me = actions.get(id);
    return [...actions.values()].filter((o) => o.id !== id && !o.native && bindingsOf(o).includes(combo) && (!me || clashes(me, o)));
  }

  // ---- persistence ----------------------------------------------------------------------------------
  const plain = (o) => { const out = {}; for (const k of Object.keys(o)) out[k] = [...o[k]]; return out; };
  function sanitise(raw) {
    const out = Object.create(null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const id of Object.keys(raw).slice(0, 300)) {
      if (id === '__proto__' || !/^[\w.-]{1,60}$/.test(id) || !Array.isArray(raw[id])) continue;
      out[id] = [...new Set(raw[id].map(parse).filter(Boolean))].slice(0, 10);
    }
    return out;
  }

  let lastSaved = null;
  function persist() {
    try {
      lastSaved = plain(overrides);
      emw.settings.set('shortcuts', lastSaved);
    } catch { /* the settings layer already toasts if saving fails */ }
  }

  function setBindings(id, next) {
    const a = actions.get(id);
    const list = [...new Set(next.map(parse).filter(Boolean))].slice(0, 10);
    const same = a && list.length === a.defaults.length && list.every((c, i) => c === a.defaults[i]);
    if (same) delete overrides[id]; else overrides[id] = list;   // only differences are stored
    persist();
    changed();
  }

  // Runs a change and offers Undo, which puts the whole previous set back.
  function withUndo(message, fn) {
    const before = plain(overrides);
    fn();
    emw.toast(message, { action: { label: 'Undo', run: () => {
      overrides = sanitise(before);
      persist();
      changed();
    } } });
  }

  function resetAll() {
    if (!Object.keys(overrides).length) { emw.toast('Shortcuts are already at their defaults', { ms: 2200 }); return; }
    withUndo('All shortcuts reset to their defaults', () => { overrides = Object.create(null); persist(); changed(); });
  }

  // ---- dispatch -------------------------------------------------------------------------------------
  let capturing = null;
  document.addEventListener('keydown', (e) => {
    if (capturing) { capturing(e); return; }   // the editor is waiting for the next combination
    const combo = fromEvent(e);
    if (!combo) return;
    const list = index().get(combo);
    if (!list) return;
    if (NATIVE.has(combo) && emw.isTextField(e.target)) return;   // never take editing keys from a text box
    for (const a of list) {
      try { if (a.when && !a.when(e, combo)) continue; } catch { continue; }
      e.preventDefault();
      try { a.run(e); } catch (err) { console.error('Shortcut failed:', a.id, err); }
      return;
    }
  }, true);

  // While the viewer records a new binding, the next keydown goes to `fn(e, combo)` and nowhere else.
  function capture(fn) {
    capturing = (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn(e, fromEvent(e));
    };
    return () => { capturing = null; };
  }

  emw.keys = {
    register, parse, fromEvent, reservedReason, isNative, conflicts, capture,
    format: menuLabel,
    bindings: (id) => { const a = actions.get(id); return a ? [...bindingsOf(a)] : []; },
    defaults: (id) => { const a = actions.get(id); return a ? [...a.defaults] : []; },
    // What a menu shows for an action: its first effective binding ('' when unbound).
    display: (id) => { const a = actions.get(id); const b = a ? bindingsOf(a)[0] : ''; return b ? menuLabel(b) : ''; },
    has: (id) => actions.has(id),
    isHidden: (id) => { const a = actions.get(id); return !!a && a.secret && !bindingsOf(a).length; },
    list: () => [...actions.values()].map((a) => ({ id: a.id, label: a.label, group: a.group, secret: a.secret, native: a.native, bindings: [...bindingsOf(a)], defaults: [...a.defaults] })),
    setBindings, resetAll,
    onChange: (cb) => listeners.push(cb)
  };

  // Settings is loaded before this file, so the saved overrides are already available.
  try { overrides = sanitise(emw.settings.get('shortcuts')); } catch { /* start from the defaults */ }
  emw.settings.onChange((key, value) => {
    if (key !== 'shortcuts' || value === lastSaved) return;
    overrides = sanitise(value);
    changed();
  });

  // ---- built-in actions ---------------------------------------------------------------------------------
  // Actions whose code lives in other files register there. These are the ones this file owns:
  // settings.js loads before the registry, and the rest are menu entries or navigation.
  const noModal = () => !document.querySelector('dialog[open]');

  register({ id: 'openSettings', label: 'Settings', group: 'File', keys: 'Ctrl+,' });
  register({ id: 'deleteCurrent', label: 'Delete current chapter or scene', group: 'File' });
  register({ id: 'selectAll', label: 'Select all', group: 'Edit', keys: 'Ctrl+A', native: true });   // shown for reference; the browser handles it
  register({ id: 'customiseBottomBar', label: 'Customise bottom bar', group: 'View' });
  register({ id: 'openShortcuts', label: 'Keyboard shortcuts', group: 'View', keys: 'Ctrl+/' });
  emw.actions.openShortcuts = () => emw.settings.open('shortcuts');

  // Tabs follow the visible order from the `tabs` setting, so hidden or reordered tabs behave.
  const visibleTabs = () => {
    const { order, hidden } = emw.tabbar.normalise(emw.settings.get('tabs'));
    return order.filter((id) => !hidden.includes(id));
  };
  const goToTab = (n) => { const id = visibleTabs()[n - 1]; if (id) emw.showView(id); };   // showView ignores non-Home tabs with no book
  function stepTab(dir) {
    if (!(emw.book && emw.book.id)) return;   // only Home is reachable without a book
    const tabs = visibleTabs();
    if (!tabs.length) return;
    const at = tabs.indexOf(emw.view());
    const next = at < 0 ? (dir > 0 ? 0 : tabs.length - 1) : (at + dir + tabs.length) % tabs.length;
    emw.showView(tabs[next]);
  }
  Object.assign(emw.actions, { goToTab, nextTab: () => stepTab(1), prevTab: () => stepTab(-1) });

  for (let n = 1; n <= 8; n++) {
    emw.actions['goTab' + n] = () => goToTab(n);
    register({ id: 'goTab' + n, label: 'Go to tab ' + n, group: 'Navigate', keys: 'Ctrl+' + n, when: noModal });
  }
  register({ id: 'nextTab', label: 'Next tab', group: 'Navigate', keys: 'Ctrl+PageDown', when: noModal });
  register({ id: 'prevTab', label: 'Previous tab', group: 'Navigate', keys: 'Ctrl+PageUp', when: noModal });
  // One action per view, with no default key, so the writer can bind them.
  for (const t of emw.tabbar.TABS) {
    const id = t.id === 'home' ? 'goHome' : 'go' + t.label;
    register({ id, label: 'Go to ' + t.label, group: 'Navigate', when: noModal });
  }

  // ---- the Shortcuts section of Settings ----------------------------------------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const btn = (cls, text) => { const b = el('button', cls, text); b.type = 'button'; return b; };

  function caps(combo) {
    const k = el('kbd');
    k.append(...splitCombo(combo).map((p) => el('span', 'kb-key', capLabel(p))));
    return k;
  }

  let paintList = null;        // set while the section is on screen
  const stopDialogCancel = (e) => { if (capturing) e.preventDefault(); };   // Escape while recording must not close Settings

  function render(pane) {
    let query = '';
    let rec = null;             // { id, index, cancel }: index -1 means "adding a new binding"
    let pending = null;         // a conflict waiting for Replace or Cancel
    let focusAfter = null;
    pane.closest('dialog')?.addEventListener('cancel', stopDialogCancel);

    pane.append(el('h2', null, 'Shortcuts'));
    pane.append(el('p', 'st-hint kb-intro', 'Click a shortcut to change it, or use the + beside an action to add another. While recording, Escape cancels and Backspace removes the shortcut.'));

    const bar = el('div', 'kb-bar');
    const search = el('input', 'kb-search');
    search.type = 'text';
    search.placeholder = 'Search shortcuts';
    search.setAttribute('aria-label', 'Search shortcuts');
    search.spellcheck = false;
    const resetAllBtn = btn('st-reset', 'Reset all shortcuts');
    bar.append(search, resetAllBtn);
    const status = el('div', 'kb-status');
    status.setAttribute('role', 'status');
    const host = el('div', 'kb-host');
    pane.append(bar, status, host);

    const say = (text) => { pending = null; status.replaceChildren(); if (text) status.append(el('span', null, text)); };

    function stopRec() { if (rec) { rec.cancel(); document.removeEventListener('mousedown', outside, true); rec = null; } }
    function outside(e) { if (rec && !e.target.closest('.kb-chip.recording')) { stopRec(); say(''); paint(); } }

    // Applies a new set of bindings for `id`, asking first if it would take a key from another action.
    function attempt(id, next, { message, focus } = {}) {
      const own = new Set(emw.keys.bindings(id));
      const found = [];
      for (const c of next) if (!own.has(c)) for (const o of conflicts(c, id)) found.push({ combo: c, other: o });
      focusAfter = focus || { id };
      const commit = () => {
        if (message) withUndo(message, () => setBindings(id, next)); else setBindings(id, next);
      };
      if (!found.length) { say(''); commit(); return; }
      pending = { id, next };
      status.replaceChildren();
      const first = found[0];
      const more = found.length > 1 ? ` (and ${found.length - 1} more)` : '';
      status.append(el('span', null, `${menuLabel(first.combo)} is already used by “${first.other.label}”${more}.`));
      const replace = btn(null, 'Replace');
      const cancel = btn(null, 'Cancel');
      replace.addEventListener('click', () => {
        say('');
        withUndo(`Moved ${menuLabel(first.combo)}${found.length > 1 ? ' and others' : ''} to “${actions.get(id).label}”`, () => {
          for (const f of found) setBindings(f.other.id, emw.keys.bindings(f.other.id).filter((b) => b !== f.combo));
          setBindings(id, next);
        });
      });
      cancel.addEventListener('click', () => { say(''); paint(); });
      status.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pending) { e.stopPropagation(); say(''); paint(); } }, { once: true });
      status.append(replace, cancel);
      replace.focus();
    }

    function startRec(id, index) {
      stopRec();
      say(`Press the keys for “${actions.get(id).label}”. Escape cancels, Backspace removes.`);
      const cancel = emw.keys.capture((e, combo) => {
        const mods = e.ctrlKey || e.altKey || e.metaKey;
        if (e.key === 'Escape' && !mods) { stopRec(); say('Cancelled.'); focusAfter = { id }; paint(); return; }
        if (e.key === 'Backspace' && !mods && !e.shiftKey) {
          stopRec();
          const cur = emw.keys.bindings(id);
          if (index >= 0) attempt(id, cur.filter((_, i) => i !== index), { message: `Removed a shortcut from “${actions.get(id).label}”` });
          else { say(''); focusAfter = { id }; paint(); }
          return;
        }
        if (!combo) return;   // a bare modifier: keep waiting for the real key
        const why = reservedReason(combo);
        if (why) { say(`${why} Press another combination.`); return; }
        const cur = emw.keys.bindings(id);
        if (cur.includes(combo)) {
          if (cur[index] === combo) { stopRec(); say(''); focusAfter = { id }; paint(); }
          else say(`${menuLabel(combo)} is already one of this action’s shortcuts. Press another combination.`);
          return;
        }
        stopRec();
        const next = index >= 0 ? cur.map((c, i) => (i === index ? combo : c)) : [...cur, combo];
        attempt(id, next);
      });
      rec = { id, index, cancel };
      document.addEventListener('mousedown', outside, true);
      focusAfter = { id, recording: true };
      paint();
    }

    function matches(a, q) {
      if (!q) return true;
      const hay = (a.label + ' ' + a.group + ' ' + a.bindings.map(menuLabel).join(' ')).toLowerCase();
      return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
    }

    function row(a) {
      const li = el('li', 'kb-row');
      li.dataset.id = a.id;
      li.append(el('span', 'kb-name', a.label));
      const cell = el('span', 'kb-binds');
      if (a.native) {
        a.bindings.forEach((c) => cell.append(caps(c)));
        cell.append(el('span', 'kb-note', 'Built in'));
        li.append(cell);
        return li;
      }
      a.bindings.forEach((c, i) => {
        if (rec && rec.id === a.id && rec.index === i) {
          const r = btn('kb-chip recording', 'Press the keys…');
          r.setAttribute('aria-label', `Recording a new shortcut for ${a.label}`);
          cell.append(r);
          return;
        }
        const b = btn('kb-chip');
        b.append(caps(c));
        b.setAttribute('aria-label', `${a.label}: ${spoken(menuLabel(c))}. Change shortcut`);
        b.addEventListener('click', () => startRec(a.id, i));
        cell.append(b);
      });
      if (rec && rec.id === a.id && rec.index === -1) {
        const r = btn('kb-chip recording', 'Press the keys…');
        r.setAttribute('aria-label', `Recording an extra shortcut for ${a.label}`);
        cell.append(r);
      } else if (!a.bindings.length) {
        cell.append(el('span', 'kb-note', 'Not set'));
      }
      const add = btn('kb-add', '+');
      add.setAttribute('aria-label', `Add a shortcut for ${a.label}`);
      add.title = 'Add a shortcut';
      add.addEventListener('click', () => startRec(a.id, -1));
      cell.append(add);
      if (hasOwn(overrides, a.id)) {
        const r = btn('kb-reset', 'Reset');
        r.setAttribute('aria-label', `Reset ${a.label} to its default`);
        r.addEventListener('click', () => {
          stopRec();
          attempt(a.id, emw.keys.defaults(a.id), { message: `“${a.label}” reset to its default`, focus: { id: a.id } });
        });
        cell.append(r);
      }
      li.append(cell);
      return li;
    }

    function paint() {
      host.replaceChildren();
      const all = emw.keys.list().filter((a) => !(a.secret && !a.bindings.length));
      const shown = all.filter((a) => matches(a, query.trim()));
      for (const g of GROUPS) {
        const rows = shown.filter((a) => a.group === g);
        if (!rows.length) continue;
        const h = el('h3', 'st-sub', g);
        const ul = el('ul', 'kb-list');
        ul.setAttribute('aria-label', g + ' shortcuts');
        rows.forEach((a) => ul.append(row(a)));
        host.append(h, ul);
      }
      if (!shown.length) host.append(el('p', 'st-hint', 'No shortcuts match your search.'));
      if (focusAfter) {
        const li = [...host.querySelectorAll('.kb-row')].find((n) => n.dataset.id === focusAfter.id);
        const target = li && (focusAfter.recording ? li.querySelector('.recording') : li.querySelector('.kb-chip, .kb-add'));
        if (target) target.focus();
        focusAfter = null;
      }
    }

    search.addEventListener('input', () => { query = search.value; stopRec(); paint(); });
    resetAllBtn.addEventListener('click', () => { stopRec(); say(''); resetAll(); });
    paintList = () => { if (pane.isConnected) paint(); else paintList = null; };
    paint();
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Added once every file has loaded, so Shortcuts sits after Writing, Bottom bar and Library.
    emw.settings.addSection({ id: 'shortcuts', label: 'Shortcuts', render });
    changed(false);
  });
  emw.keys.onChange(() => { if (paintList) paintList(); });
})();
