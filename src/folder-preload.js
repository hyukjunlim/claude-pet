'use strict';

// What folder mode's page may ask of the main process (context isolation, sandboxed).

const { contextBridge, ipcRenderer } = require('electron');

function listen(channel) {
  return (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('folder', {
  onTree: listen('folder:tree'),
  onNotices: listen('folder:notices'),
  onUsage: listen('folder:usage'),
  onPet: listen('folder:pet'),
  onMotion: listen('folder:motion'),
  onStatus: listen('folder:status'),
  onWake: listen('folder:wake'),
  ready: () => ipcRenderer.send('folder:ready'),
  open: (id) => ipcRenderer.send('folder:open', String(id)),
  activatePet: () => ipcRenderer.send('folder:pet-click'),
  petMode: () => ipcRenderer.send('folder:pet-mode'),
  contextMenu: (screenX, screenY) => ipcRenderer.send('folder:context-menu', { screenX, screenY }),
});
