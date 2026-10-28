const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadNovel: () => ipcRenderer.invoke('novel:load'),
  writeIndex: (index) => ipcRenderer.invoke('index:write', index),
  readChapter: (id) => ipcRenderer.invoke('chapter:read', id),
  writeChapter: (id, html) => ipcRenderer.invoke('chapter:write', id, html),
  createChapter: () => ipcRenderer.invoke('chapter:create'),
  deleteChapter: (id) => ipcRenderer.invoke('chapter:delete', id),
  getLibrary: () => ipcRenderer.invoke('library:get'),
  writeLibrary: (lib) => ipcRenderer.invoke('library:write', lib),
  createBook: (title) => ipcRenderer.invoke('book:create', title),
  openBook: (id) => ipcRenderer.invoke('book:open', id),
  closeBook: () => ipcRenderer.invoke('book:close'),
  renameBook: (id, title) => ipcRenderer.invoke('book:rename', id, title),
  deleteBook: (id) => ipcRenderer.invoke('book:delete', id),
  revealBook: (id) => ipcRenderer.invoke('book:reveal', id),
  chooseLibraryFolder: () => ipcRenderer.invoke('library:choose-folder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  onBeforeClose: (cb) => ipcRenderer.on('before-close', () => cb()),
  closeReady: () => ipcRenderer.send('close-ready')
});
