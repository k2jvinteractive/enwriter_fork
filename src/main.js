const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

// Storage layout (in the OS user-data folder):
//   novel/index.json          title + ordered chapter list (small, fast to load)
//   novel/chapters/<id>.txt   one plain-text file per chapter
const root = () => path.join(app.getPath('userData'), 'novel');
const chaptersDir = () => path.join(root(), 'chapters');
const indexFile = () => path.join(root(), 'index.json');
const chapterFile = (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid chapter id');
  return path.join(chaptersDir(), id + '.txt');
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
    const first = { id: randomUUID(), title: 'Chapter 1', words: 0 };
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
  ipcMain.handle('chapter:write', (_e, id, text) => writeAtomic(chapterFile(id), text));
  ipcMain.handle('chapter:create', async () => {
    const id = randomUUID();
    await writeAtomic(chapterFile(id), '');
    return id;
  });
  ipcMain.handle('chapter:delete', (_e, id) => fs.rm(chapterFile(id), { force: true }));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false, // avoid a white flash; show once the first frame is ready
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161b22' : '#eceee9',
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
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
