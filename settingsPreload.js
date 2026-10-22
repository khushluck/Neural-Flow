const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('nf', {
  getSettings: call('settings:get'),
  saveSettings: call('settings:save'),
  getHistory: call('history:get'),
  deleteHistory: call('history:delete'),
  clearHistory: call('history:clear'),
  copy: call('clipboard:copy'),
  pickFile: call('file:pick'),
  testKey: call('key:test'),
  openExternal: call('open:external'),
  onTab: (fn) => ipcRenderer.on('tab', (_e, t) => fn(t)),
});
