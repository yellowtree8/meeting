'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zhimianDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  systemAudio: process.platform === 'win32' ? 'WASAPI loopback' : 'unsupported',
  setCompact: (compact) => ipcRenderer.invoke('zhimian:set-compact', compact),
  setContentProtection: (enabled) => ipcRenderer.invoke('zhimian:set-content-protection', enabled),
}));
