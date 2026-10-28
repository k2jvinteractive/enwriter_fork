const { app, BrowserWindow, Menu, ipcMain, nativeTheme, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const library = require('./library');

nativeTheme.themeSource = 'dark';

// Storage now lives in a library of .mwt packages (see library.js). The existing channels
// (novel:load, index:write, chapter:*) still work, against whichever book is open.

// Write to a temp file, then rename, so a crash never leaves a half-written file.
async function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

function registerIpc() {
  library.create({ app, dialog, shell, writeAtomic }).register(ipcMain);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 520,
    title: 'emwriter',
    show: false, // avoid a flash; show once the first frame is ready
    backgroundColor: '#222222',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
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
