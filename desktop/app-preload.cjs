'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mySearchDesktop', Object.freeze({
  openBrowser: url => ipcRenderer.invoke('desktop:open-browser', typeof url === 'string' ? url : ''),
  onBrowserClip: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, clip) => callback(clip);
    ipcRenderer.on('desktop:browser-clip', listener);
    return () => ipcRenderer.removeListener('desktop:browser-clip', listener);
  },
}));
