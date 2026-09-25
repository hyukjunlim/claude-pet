'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function listen(channel) {
  return (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('pet', {
  onPet: listen('pet:pet'),
  onLayout: listen('pet:layout'),
  onSessions: listen('pet:sessions'),
  onCursor: listen('pet:cursor'),
  onWake: listen('pet:wake'),
  onLanded: listen('pet:landed'),
  ready: () => ipcRenderer.send('pet:ready'),
  setInteractive: (value) => ipcRenderer.send('pet:interactive', value === true),
  dragStart: (screenX, screenY) => ipcRenderer.send('pet:drag-start', { screenX, screenY }),
  dragMove: (screenX, screenY) => ipcRenderer.send('pet:drag-move', { screenX, screenY }),
  dragEnd: (vx, vy) => ipcRenderer.send('pet:drag-end', { vx, vy }),
  activate: (id) => ipcRenderer.send('pet:activate', typeof id === 'string' ? id : null),
  dismiss: (id) => ipcRenderer.send('pet:dismiss', id),
  traySize: (height) => ipcRenderer.send('pet:tray-size', Number(height) || 0),
  contextMenu: (screenX, screenY) => ipcRenderer.send('pet:context-menu', { screenX, screenY }),
});
