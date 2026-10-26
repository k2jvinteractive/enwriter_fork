const { app, BrowserWindow, Menu, ipcMain, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

nativeTheme.themeSource = 'dark';

// Storage layout (in the OS user-data folder):
//   novel/index.json           title + ordered chapter list (small, fast to load)
//   novel/chapters/<id>.html   one file per chapter
const root = () => path.join(app.getPath('userData'), 'novel');
const chaptersDir = () => path.join(root(), 'chapters');
const indexFile = () => path.join(root(), 'index.json');
const chapterFile = (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid chapter id');
  return path.join(chaptersDir(), id + '.html');
};

// Write to a temp file, then rename, so a crash never leaves a half-written file.
async function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

async function loadNovel() {
  await fs.mkdir(chaptersDir(), { recursive: true });
  try {
    return JSON.parse(await fs.readFile(indexFile(), 'utf8'));
  } catch {
    const first = { id: randomUUID(), title: 'Chapter 1', words: 0, synopsis: '' };
    const index = { title: 'Untitled Novel', chapters: [first] };
    await writeAtomic(chapterFile(first.id), '');
    await writeAtomic(indexFile(), JSON.stringify(index, null, 2));
    return index;
  }
}

function registerIpc() {
  ipcMain.handle('novel:load', loadNovel);
  ipcMain.handle('index:write', (_e, index) =>
    writeAtomic(indexFile(), JSON.stringify(index, null, 2)));
  ipcMain.handle('chapter:read', async (_e, id) => {
    try { return await fs.readFile(chapterFile(id), 'utf8'); } catch { return ''; }
  });
  ipcMain.handle('chapter:write', (_e, id, html) => writeAtomic(chapterFile(id), html));
  ipcMain.handle('chapter:create', async () => {
    const id = randomUUID();
    await writeAtomic(chapterFile(id), '');
    return id;
  });
  ipcMain.handle('chapter:delete', (_e, id) => fs.rm(chapterFile(id), { force: true }));
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
