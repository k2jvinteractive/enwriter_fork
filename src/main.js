const { app, BrowserWindow, Menu, ipcMain, nativeTheme, dialog, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const library = require('./library');
const { SPELL_LANGUAGES, sanitiseWords } = library;

// Window colours per resolved theme; must match --bg in styles.css so the window never flashes the
// wrong colour while it opens.
const THEME_BG = { dark: '#222222', light: '#f1eee8' };
const THEMES = ['dark', 'light', 'system'];
const resolvedTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
function applyTheme(pref) {
  // 'system' lets Chromium follow the OS; this also drives prefers-color-scheme in the page.
  nativeTheme.themeSource = THEMES.includes(pref) ? pref : 'dark';
}
let lib = null;

// Storage now lives in a library of .mwt packages (see library.js). The existing channels
// (novel:load, index:write, chapter:*) still work, against whichever book is open.

// Write to a temp file, then rename, so a crash never leaves a half-written file.
async function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

function registerIpc() {
  lib = library.create({ app, dialog, shell, writeAtomic });
  lib.register(ipcMain);
  // Apply the saved theme before any window exists, and again whenever the setting changes.
  applyTheme(lib.getSettings().theme);
  // Spell check is off until the writer turns it on. The spell checker itself stays available
  // (webPreferences.spellcheck) so it can be switched on and off for the whole session.
  session.defaultSession.setSpellCheckerEnabled(lib.getSettings().spellcheck === true);
  lib.onSettingChange((key, value) => {
    if (key === 'theme') applyTheme(value);
    if (key === 'spellcheck') session.defaultSession.setSpellCheckerEnabled(value === true);
    if (key === 'customWords') syncWords(value);
  });
  // Part 7c: start in the default language and make the session's dictionary match the saved list.
  // A book may switch the language later (the renderer asks through spell:set-language).
  setSpellLanguage(lib.getSettings().spellLanguage).catch(() => {});
  syncWords(lib.getSettings().customWords, true);
  ipcMain.handle('spell:info', () => ({ system: SYSTEM_SPELLER, language: SYSTEM_SPELLER ? null : currentLang }));
  ipcMain.handle('spell:set-language', (_e, id) => setSpellLanguage(id));

  // spell:replace swaps the misspelled word of the last right-click for a suggestion. The renderer
  // only sends the replacement text, never a range, and only right after a context menu was shown.
  ipcMain.handle('spell:replace', (e, text) => {
    const c = spellCtx;
    if (!c || e.sender !== c.sender || c.sender.isDestroyed() || !c.misspelled || Date.now() - c.at > 10000) return false;
    if (typeof text !== 'string' || text.length < 1 || text.length > 100 || CONTROL_CHARS.test(text)) return false;
    spellCtx = null;   // one replacement per context menu
    c.sender.replaceMisspelling(text);
    return true;
  });
}

// ---- spell check language and custom dictionary (part 7c) ---------------------------------------
// macOS uses the system checker, which picks the language itself; setSpellCheckerLanguages does nothing there.
const SYSTEM_SPELLER = process.platform === 'darwin';
const LANG_TIMEOUT = 25000;
let currentLang = null;   // set once the checker has confirmed a language
let langChain = Promise.resolve();

const tellWindows = (channel, data) => {
  for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send(channel, data); }
};

// Switch the checker's language. On Windows and Linux the dictionary may have to be downloaded, so
// this waits for Chromium to say it is ready (or that the download failed) and answers { ok, language }.
// On failure the previous language is put back, so the checker is never left without a dictionary.
// Requests run one at a time; a later one waits for the earlier one to finish.
function setSpellLanguage(id) {
  const run = () => new Promise((resolve) => {
    if (!SPELL_LANGUAGES.some((l) => l.id === id)) { resolve({ ok: false, language: currentLang, reason: 'unknown' }); return; }
    if (SYSTEM_SPELLER || id === currentLang) { resolve({ ok: true, language: currentLang }); return; }
    const ses = session.defaultSession;
    // What the checker has now (at first start Chromium picks one from the system locale). A language
    // it already has loaded sends no event, so waiting for one would only time out.
    const had = ses.getSpellCheckerLanguages();
    if (had.length === 1 && had[0] === id) { currentLang = id; resolve({ ok: true, language: id }); return; }
    const previous = had.length ? had : (currentLang ? [currentLang] : []);
    let timer = 0;
    const done = (result) => {
      clearTimeout(timer);
      ses.removeListener('spellcheck-dictionary-initialized', onReady);
      ses.removeListener('spellcheck-dictionary-download-success', onReady);
      ses.removeListener('spellcheck-dictionary-download-failure', onFail);
      resolve(result);
    };
    const fail = (reason) => {
      try { if (previous.length) ses.setSpellCheckerLanguages(previous); } catch { /* the old dictionary is still loaded */ }
      done({ ok: false, language: currentLang, reason });
    };
    const onReady = (_e, code) => { if (code === id) { currentLang = id; done({ ok: true, language: id }); } };
    const onFail = (_e, code) => { if (code === id) fail('download'); };
    ses.on('spellcheck-dictionary-initialized', onReady);
    ses.on('spellcheck-dictionary-download-success', onReady);
    ses.on('spellcheck-dictionary-download-failure', onFail);
    timer = setTimeout(() => fail('timeout'), LANG_TIMEOUT);
    try {
      // Not every Electron build offers every code; asking for one it lacks would only log an error.
      if (ses.availableSpellCheckerLanguages && !ses.availableSpellCheckerLanguages.includes(id)) { fail('unavailable'); return; }
      ses.setSpellCheckerLanguages([id]);
    } catch { fail('error'); }
  });
  langChain = langChain.catch(() => {}).then(run);
  return langChain;
}

// The renderer shows progress for downloads it asked for (and for the first one at startup).
function watchDictionaryDownloads() {
  const ses = session.defaultSession;
  for (const [event, state] of [['spellcheck-dictionary-download-begin', 'begin'], ['spellcheck-dictionary-download-success', 'success'], ['spellcheck-dictionary-download-failure', 'failure']]) {
    ses.on(event, (_e, code) => { if (SPELL_LANGUAGES.some((l) => l.id === code)) tellWindows('spell:download', { state, language: code }); });
  }
}

// The words the session has, so only the difference is added or removed. The list in settings.json is
// the truth: main cleans it again here and never trusts what the renderer sent. Syncs run one at a time.
let appliedWords = null;   // Set of words as the session holds them; null until the first sync read them
let wordChain = Promise.resolve();
function syncWords(list, first = false) {
  const wanted = new Set(sanitiseWords(list));
  wordChain = wordChain.catch(() => {}).then(async () => {
    const ses = session.defaultSession;
    if (appliedWords === null || first) {
      // Chromium keeps its own custom dictionary file between runs; anything in it that is not in our list goes.
      try { appliedWords = new Set(await ses.listWordsInSpellCheckerDictionary()); } catch { appliedWords = new Set(); }
    }
    for (const w of [...appliedWords]) {
      if (!wanted.has(w)) { try { ses.removeWordFromSpellCheckerDictionary(w); } catch { /* ignore */ } appliedWords.delete(w); }
    }
    for (const w of wanted) {
      if (!appliedWords.has(w)) { try { if (ses.addWordToSpellCheckerDictionary(w)) appliedWords.add(w); } catch { /* ignore */ } }
    }
  });
  return wordChain;
}

// The last right-click, as reported by Chromium: lets spell:replace check it was asked for.
let spellCtx = null;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const cleanWord = (s) => typeof s === 'string' && s.length > 0 && s.length <= 100 && !CONTROL_CHARS.test(s);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 520,
    title: 'enWriter',
    show: false, // avoid a flash; show once the first frame is ready
    backgroundColor: THEME_BG[resolvedTheme()],
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  // OS theme changes (and our own themeSource changes): recolour the window and tell the page.
  const onThemeUpdated = () => {
    if (win.isDestroyed()) return;
    win.setBackgroundColor(THEME_BG[resolvedTheme()]);
    win.webContents.send('theme:updated', resolvedTheme());
  };
  nativeTheme.on('updated', onThemeUpdated);
  win.on('closed', () => nativeTheme.removeListener('updated', onThemeUpdated));

  // The renderer cannot see the spell checker, so Chromium's right-click report is forwarded to it.
  // x and y are in screen-scaled pixels; the page works in CSS pixels, so divide by the UI zoom.
  win.webContents.on('context-menu', (_e, p) => {
    const s = lib.getSettings();
    const zoom = (s.uiScale || 100) / 100;
    const word = s.spellcheck === true && cleanWord(p.misspelledWord) ? p.misspelledWord : '';
    const flags = p.editFlags || {};
    spellCtx = { at: Date.now(), sender: win.webContents, misspelled: !!word };
    win.webContents.send('spell:context', {
      x: p.x / zoom, y: p.y / zoom, word,
      suggestions: word ? (p.dictionarySuggestions || []).filter(cleanWord).slice(0, 5) : [],
      canCut: !!flags.canCut, canCopy: !!flags.canCopy, canPaste: !!flags.canPaste, inEditable: !!p.isEditable
    });
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links inside the editor must never navigate the app window.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }

  // Ask the window to save before closing, so nothing typed is ever lost.
  let forceClose = false;
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    win.webContents.send('before-close');
    setTimeout(() => { forceClose = true; if (!win.isDestroyed()) win.close(); }, 3000);
  });
  ipcMain.once('close-ready', () => { forceClose = true; if (!win.isDestroyed()) win.close(); });
}

app.whenReady().then(() => {
  // Windows/Linux: the app draws its own menu bar. macOS needs a native menu for shortcuts.
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null);
  registerIpc();
  watchDictionaryDownloads();
  createWindow();
  // Part 7e: tidy deleted snapshots in the background; never holds up the window.
  lib.startup().catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
