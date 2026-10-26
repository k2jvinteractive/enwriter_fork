const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadNovel: () => ipcRenderer.invoke('novel:load'),
  writeIndex: (index) => ipcRenderer.invoke('index:write', index),
  readChapter: (id) => ipcRenderer.invoke('chapter:read', id),
  writeChapter: (id, html) => ipcRenderer.invoke('chapter:write', id, html),
  createChapter: () => ipcRenderer.invoke('chapter:create'),
  deleteChapter: (id) => ipcRenderer.invoke('chapter:delete', id),
  onBeforeClose: (cb) => ipcRenderer.on('before-close', () => cb()),
  closeReady: () => ipcRenderer.send('close-ready')
});
