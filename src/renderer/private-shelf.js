// Part 7h: the private shelf, renderer side.
//
// This is privacy from someone glancing at the screen, not encryption: the files stay readable on disk.
// The password, the list of hidden books and the lock itself live in the main process (private-shelf.js,
// library.js). This file only asks for the password, remembers whether the shelf is open, locks it
// again at the right moments, and draws the setup in Settings > Library. Home (home.js) draws the shelf.
//
// Until a password is set nothing here does anything visible: the gesture and the key do nothing,
// and the only trace is the setup row in Settings.
(() => {
  'use strict';
  const emw = window.emw;
  const st = emw.settings;

  const IDLE_LOCK_MS = 5 * 60 * 1000;     // no input at all
  const BLUR_LOCK_MS = 2 * 60 * 1000;     // window not focused
  const MIN_LENGTH = 6;                   // main enforces it too

  let enabled = false;
  let unlocked = false;
  const listeners = [];
  let lastInput = Date.now();
  let blurredAt = 0;
  let watch = 0;

  // Error text from the main process arrives wrapped by Electron; show only the sentence.
  const plain = (err, fallback) => (err && err.message ? String(err.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : '') || fallback;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const when = (secs) => (secs >= 120 ? `${Math.ceil(secs / 60)} minutes` : `${Math.max(1, Math.ceil(secs))} seconds`);

  const changed = () => { for (const cb of listeners) { try { cb(unlocked, enabled); } catch { /* one listener must not break the others */ } } };

  // ---- state ----------------------------------------------------------------------------------
  async function refresh() {
    try {
      const s = await window.api.privateStatus();
      enabled = !!(s && s.enabled);
      const was = unlocked;
      unlocked = enabled && !!(s && s.unlocked);
      updateWatch();
      if (was !== unlocked) changed();
    } catch { /* keep what we know */ }
  }

  // Locks right away on screen, then tells the main process once Home's pending writes are done
  // (a move to the shelf that is still on its way to disk must not arrive after the lock).
  async function lock() {
    if (!unlocked) return;
    unlocked = false;
    updateWatch();
    changed();
    try { if (emw.home && emw.home.settle) await emw.home.settle(); } catch { /* ignore */ }
    for (let i = 0; i < 2; i++) {
      try { await window.api.privateLock(); return; } catch { /* try once more */ }
    }
  }

  function unlockedNow() {
    unlocked = true;
    lastInput = Date.now();
    blurredAt = document.hasFocus() ? 0 : Date.now();
    updateWatch();
    changed();
  }

  // ---- when it locks again ------------------------------------------------------------------------
  // Leaving Home, the lock control (Home draws it), 5 minutes without input, 2 minutes out of focus.
  const touch = () => { lastInput = Date.now(); };
  for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel']) document.addEventListener(type, touch, { capture: true, passive: true });
  window.addEventListener('blur', () => { if (!blurredAt) blurredAt = Date.now(); });
  window.addEventListener('focus', () => { touch(); checkTimers(); blurredAt = 0; });

  function checkTimers() {
    if (!unlocked) return;
    const now = Date.now();
    if (now - lastInput >= IDLE_LOCK_MS || (blurredAt && now - blurredAt >= BLUR_LOCK_MS)) lock();
  }
  // The timer only runs while the shelf is open.
  function updateWatch() {
    if (unlocked && !watch) watch = setInterval(checkTimers, 5000);
    else if (!unlocked && watch) { clearInterval(watch); watch = 0; }
  }
  emw.onView((name) => { if (name !== 'home') lock(); });

  // ---- the "Passphrase" dialog ----------------------------------------------------------------------
  // One password box and nothing that says what it opens. A wrong password only ever gets
  // "That did not match." (also while the main process is making the person wait).
  let dlg = null, field = null, note = null, okBtn = null, finishAsk = null, asking = false;

  function ensureDialog() {
    if (dlg) return;
    dlg = el('dialog', 'priv-dialog');
    dlg.setAttribute('aria-label', 'Passphrase');
    dlg.append(el('h3', 'priv-title', 'Passphrase'));
    field = el('input');
    field.type = 'password';
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.maxLength = 200;
    field.setAttribute('aria-label', 'Passphrase');
    note = el('p', 'priv-note');
    note.setAttribute('role', 'status');
    const foot = el('div', 'dialog-actions');
    const cancel = el('button', 'quiet', 'Cancel');
    cancel.type = 'button';
    okBtn = el('button', null, 'OK');
    okBtn.type = 'button';
    foot.append(cancel, okBtn);
    dlg.append(field, note, foot);
    document.body.append(dlg);

    cancel.addEventListener('click', () => dlg.close());
    okBtn.addEventListener('click', submit);
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } e.stopPropagation(); });
    // No click-outside-to-close: the press that opened this dialog may end on its backdrop.
    dlg.addEventListener('close', () => {
      field.value = '';
      note.textContent = '';
      const f = finishAsk;
      finishAsk = null;
      if (f) f(unlocked);
    });
  }

  async function submit() {
    if (asking || !field.value) return;
    asking = true;
    okBtn.disabled = true;
    let r = null;
    try { r = await window.api.privateUnlock(field.value); } catch { r = null; }
    asking = false;
    okBtn.disabled = false;
    if (r && r.ok) { unlockedNow(); dlg.close(); return; }
    note.textContent = 'That did not match.';
    field.value = '';
    field.focus();
  }

  // Resolves true once the shelf is unlocked (at once if it already is), false if the person gave up.
  function ask() {
    if (!enabled) return Promise.resolve(false);
    if (unlocked) return Promise.resolve(true);
    ensureDialog();
    if (dlg.open) return Promise.resolve(false);
    return new Promise((resolve) => {
      finishAsk = resolve;
      field.value = '';
      note.textContent = '';
      dlg.showModal();
      field.focus();
    });
  }

  // Opens the dialog and, if it worked, shows Home with the shelf in view.
  async function open() {
    if (!enabled) return;
    const ok = await ask();
    if (!ok) return;
    if (emw.view() !== 'home') emw.showView('home');
    setTimeout(() => { const s = document.querySelector('#view-home .shelf-private'); if (s) s.scrollIntoView({ block: 'nearest' }); }, 60);
  }

  emw.priv = {
    enabled: () => enabled,
    unlocked: () => unlocked,
    ask, open, lock, refresh,
    onChange: (cb) => listeners.push(cb)
  };

  // No default key, and absent from the menus and the shortcut list until the writer binds one (Settings > Library).
  // `when` keeps the key silent (and not even swallowed) while the feature is off.
  emw.actions.openPrivateShelf = open;
  emw.keys.register({
    id: 'openPrivateShelf', label: 'Passphrase', group: 'Library', secret: true,
    when: () => enabled && !document.querySelector('dialog[open]')
  });

  // ---- Settings > Library > Private shelf ------------------------------------------------------------
  const FEATURE_TEXT = 'Hides books from Home behind a password. This only keeps them from view: it is not encryption, and the books stay readable on disk. There is no way to get a lost password back.';
  const dialogsWithGuard = new WeakSet();

  function passwordInput(label) {
    const i = el('input');
    i.type = 'password';
    i.autocomplete = 'off';
    i.spellcheck = false;
    i.maxLength = 200;
    i.placeholder = label;
    i.setAttribute('aria-label', label);
    return i;
  }
  const button = (text, cls) => { const b = el('button', cls || null, text); b.type = 'button'; return b; };

  function renderBox(box, pane) {
    let mode = 'idle';            // 'idle' | 'change' | 'disable'
    let capturing = null;         // stops a key recording
    const msg = el('p', 'st-hint priv-msg');
    msg.setAttribute('role', 'status');

    const say = (t) => { msg.textContent = t || ''; };
    const stopCapture = () => { if (capturing) { capturing(); capturing = null; } };
    const dlgEl = pane.closest('dialog');
    if (dlgEl && !dialogsWithGuard.has(dlgEl)) {
      dialogsWithGuard.add(dlgEl);
      // Escape while recording a key must not close Settings.
      dlgEl.addEventListener('cancel', (e) => { if (capturing) e.preventDefault(); });
    }

    // Wrong-password text shared by every form that asks for the current password.
    const failText = (r) => (r && r.reason === 'wait' ? `Too many tries. Try again in ${when(r.wait)}.`
      : `That did not match.${r && r.wait ? ` Try again in ${when(r.wait)}.` : ''}`);

    function paint() {
      stopCapture();
      box.replaceChildren();
      say('');
      if (!enabled) paintOff(); else if (mode === 'change') paintChange(); else if (mode === 'disable') paintDisable(); else paintOn();
      box.append(msg);
    }

    function paintOff() {
      const a = passwordInput('New password');
      const b = passwordInput('Repeat password');
      const go = button('Turn on');
      const form = el('div', 'st-libbox priv-form');
      form.append(a, b, go);
      box.append(form);
      go.addEventListener('click', async () => {
        if (a.value.length < MIN_LENGTH) { say(`Use at least ${MIN_LENGTH} characters.`); a.focus(); return; }
        if (a.value !== b.value) { say('The two passwords are not the same.'); b.focus(); return; }
        go.disabled = true;
        try {
          await window.api.privateSet(a.value);
          await emw.priv.refresh();
          paint();
          say('On. Nobody can get this password back for you, so keep it somewhere safe.');
        } catch (err) { say(plain(err, 'Could not set the password.')); }
        go.disabled = false;
      });
      for (const i of [a, b]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    }

    function paintOn() {
      box.append(el('p', 'st-hint', emw.keys.display('openPrivateShelf')
        ? 'On. Press and hold your pen name on Home, or use your shortcut, and enter the password.'
        : 'On. Press and hold your pen name on Home for a moment and enter the password. With no pen name, hold the greeting.'));
      const btns = el('div', 'st-inline');
      const change = button('Change password…');
      const off = button('Turn off…');
      btns.append(change, off);
      box.append(btns);
      change.addEventListener('click', () => { mode = 'change'; paint(); });
      off.addEventListener('click', () => { mode = 'disable'; paint(); });

      // The key that opens the dialog. It is the only way in without the mouse, and it stays out of the
      // shortcut list until it is set here.
      const keyRow = el('div', 'st-inline priv-key');
      keyRow.append(el('span', 'st-hint', 'Shortcut:'));
      const cur = emw.keys.display('openPrivateShelf');
      keyRow.append(el('span', cur ? 'priv-keyname' : 'st-hint', cur || 'Not set'));
      const set = button(cur ? 'Change…' : 'Set…');
      keyRow.append(set);
      if (cur) {
        const clear = button('Clear');
        clear.addEventListener('click', () => { emw.keys.setBindings('openPrivateShelf', []); paint(); });
        keyRow.append(clear);
      }
      set.addEventListener('click', () => {
        stopCapture();
        say('Press the keys. Escape cancels.');
        set.disabled = true;
        const end = () => { if (capturing) { capturing(); capturing = null; } };
        capturing = emw.keys.capture((e, combo) => {
          if (e.key === 'Escape' && !(e.ctrlKey || e.altKey || e.metaKey)) { end(); paint(); return; }
          if (!combo) return;                       // a bare modifier: keep waiting
          const why = emw.keys.reservedReason(combo);
          if (why) { say(`${why} Press another combination.`); return; }
          const clash = emw.keys.conflicts(combo, 'openPrivateShelf')[0];
          if (clash) { say(`${emw.keys.format(combo)} is already used by “${clash.label}”. Press another combination.`); return; }
          end();
          emw.keys.setBindings('openPrivateShelf', [combo]);
          paint();
        });
      });
      box.append(keyRow);
    }

    function paintChange() {
      const cur = passwordInput('Current password');
      const a = passwordInput('New password');
      const b = passwordInput('Repeat new password');
      const go = button('Change password');
      const cancel = button('Cancel', 'quiet');
      const form = el('div', 'st-libbox priv-form');
      const row = el('div', 'st-inline');
      row.append(go, cancel);
      form.append(cur, a, b, row);
      box.append(form);
      cancel.addEventListener('click', () => { mode = 'idle'; paint(); });
      go.addEventListener('click', async () => {
        if (!cur.value) { cur.focus(); return; }
        if (a.value.length < MIN_LENGTH) { say(`Use at least ${MIN_LENGTH} characters.`); a.focus(); return; }
        if (a.value !== b.value) { say('The two new passwords are not the same.'); b.focus(); return; }
        go.disabled = true;
        try {
          const r = await window.api.privateChange(cur.value, a.value);
          if (r && r.ok) { mode = 'idle'; paint(); say('Password changed.'); return; }
          say(failText(r));
          cur.value = '';
          cur.focus();
        } catch (err) { say(plain(err, 'Could not change the password.')); }
        go.disabled = false;
      });
      cur.focus();
    }

    function paintDisable() {
      box.append(el('p', 'st-hint', 'Every book on the private shelf moves back to a normal shelf first. Nothing is lost.'));
      const cur = passwordInput('Password');
      const go = button('Turn off');
      const cancel = button('Cancel', 'quiet');
      const form = el('div', 'st-libbox priv-form');
      const row = el('div', 'st-inline');
      row.append(go, cancel);
      form.append(cur, row);
      box.append(form);
      cancel.addEventListener('click', () => { mode = 'idle'; paint(); });
      go.addEventListener('click', async () => {
        if (!cur.value) { cur.focus(); return; }
        go.disabled = true;
        try {
          const r = await window.api.privateDisable(cur.value);
          if (r && r.ok) {
            // The key goes with the feature.
            if (emw.keys.bindings('openPrivateShelf').length) emw.keys.setBindings('openPrivateShelf', []);
            mode = 'idle';
            await emw.priv.refresh();
            try { if (emw.home) await emw.home.refresh(); } catch { /* Home redraws next time it is shown */ }
            paint();
            say('Turned off. Your books are back on a normal shelf.');
            return;
          }
          say(failText(r));
          cur.value = '';
          cur.focus();
        } catch (err) { say(plain(err, 'Could not turn it off.')); }
        go.disabled = false;
      });
      cur.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
      cur.focus();
    }

    paint();
    // The key list may change from elsewhere (undo, reset all); keep the row honest while it is on screen.
    emw.keys.onChange(() => { if (box.isConnected && mode === 'idle' && enabled && !capturing) paint(); });
  }

  st.extend('library', (pane) => {
    const box = el('div', 'st-libbox priv-box');
    const r = el('div', 'st-row');
    r.append(el('span', 'lbl', 'Private shelf'), box, el('span', 'st-hint', FEATURE_TEXT));
    pane.append(r);
    // Read the state fresh each time the section is drawn.
    refresh().then(() => renderBox(box, pane));
  });

  refresh();
})();
