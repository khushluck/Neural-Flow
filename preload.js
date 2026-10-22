const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nf', {
  on: (ch, fn) => { if (['state', 'rec:start', 'rec:stop'].includes(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a)); },
  sendAudio: (buf) => ipcRenderer.send('audio', buf),
  recFailed: () => ipcRenderer.send('rec:failed'),
});
