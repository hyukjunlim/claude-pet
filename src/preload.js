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
  onMotion: listen('pet:motion'),
  onLayout: listen('pet:layout'),
  onSessions: listen('pet:sessions'),
  onUsage: listen('pet:usage'),
  onWake: listen('pet:wake'),
  onLanded: listen('pet:landed'),
  onPointer: listen('pet:pointer'),
  ready: () => ipcRenderer.send('pet:ready'),
  pulse: () => ipcRenderer.send('pet:pulse'),
  setInteractive: (value) => ipcRenderer.send('pet:interactive', value === true),
  setInputRegions: (regions) => ipcRenderer.send('pet:input-regions', regions),
  dragStart: (screenX, screenY) => ipcRenderer.send('pet:drag-start', { screenX, screenY }),
  dragMove: (screenX, screenY) => ipcRenderer.send('pet:drag-move', { screenX, screenY }),
  dragEnd: (vx, vy, cancelled) => ipcRenderer.send('pet:drag-end', { vx, vy, cancelled }),
  resizeStep: (direction) => ipcRenderer.send('pet:resize-step', direction), // PET-SIZE
  activate: (id) => ipcRenderer.send('pet:activate', typeof id === 'string' ? id : null),
  dismiss: (id) => ipcRenderer.send('pet:dismiss', id),
  traySize: (height) => ipcRenderer.send('pet:tray-size', Number(height) || 0),
  contextMenu: (screenX, screenY) => ipcRenderer.send('pet:context-menu', { screenX, screenY }),
});
