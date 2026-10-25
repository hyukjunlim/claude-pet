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
  onStep: listen('folder:step'),     // Ctrl+Tab (+1) or Ctrl+Shift+Tab (-1)
  onFold: listen('folder:fold'),     // a row menu's Collapse or Expand: { key, open }
  onSelect: listen('folder:select'), // a session opened from its row's menu
  ready: () => ipcRenderer.send('folder:ready'),
  open: (id, via) => ipcRenderer.send('folder:open', String(id), via === 'key' ? 'key' : 'click'),
  flag: (id, on) => ipcRenderer.send('folder:flag', String(id), on === true),
  activatePet: () => ipcRenderer.send('folder:pet-click'),
  resize: (phase) => ipcRenderer.send('folder:resize', String(phase)),   // 'move', 'end' or 'reset'
  // `target`: the row clicked, if any: { kind: 'session', id } or { kind: 'folder', key, open, ids }.
  contextMenu: (screenX, screenY, target) => ipcRenderer.send('folder:context-menu', { screenX, screenY, target: target ?? null }),
});
