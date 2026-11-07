'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBrowser', Object.freeze({
  state: () => ipcRenderer.invoke('browser:state'),
  openTab: url => ipcRenderer.invoke('browser:open-tab', url),
  selectTab: id => ipcRenderer.invoke('browser:select-tab', id),
  closeTab: id => ipcRenderer.invoke('browser:close-tab', id),
  navigate: url => ipcRenderer.invoke('browser:navigate', url),
  back: () => ipcRenderer.invoke('browser:back'),
  forward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  sendSelection: () => ipcRenderer.invoke('browser:send-selection'),
  onState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
}));
