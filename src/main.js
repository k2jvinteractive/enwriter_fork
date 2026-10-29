const { app, BrowserWindow, Menu, ipcMain, nativeTheme, dialog, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const library = require('./library');

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
  });

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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
