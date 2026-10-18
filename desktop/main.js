'use strict';

const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('node:path');

function configureSystemAudioLoopback() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.audioRequested || !request.videoRequested) {
      callback(null);
      return;
    }

    try {
      const screens = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (!screens.length) {
        callback(null);
        return;
      }

      // On Windows, Electron's loopback capture uses the system output mix
      // (WASAPI loopback), so meeting audio from any app is included.
      callback({ video: screens[0], audio: 'loopback' });
    } catch (error) {
      console.error('[desktop] could not start Windows audio loopback:', error);
      callback(null);
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#f4f5f7',
    title: '知面 · 实时面试助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.platform === 'win32') win.setContentProtection(true);
  let expandedBounds = null;
  ipcMain.removeHandler('zhimian:set-compact');
  ipcMain.handle('zhimian:set-compact', (event, compact) => {
    if (event.sender !== win.webContents || typeof compact !== 'boolean') return false;
    if (compact) {
      if (!expandedBounds) expandedBounds = win.getBounds();
      win.setMinimumSize(460, 480);
      win.setSize(620, 700, true);
      win.setAlwaysOnTop(true);
      win.show();
    } else {
      win.setAlwaysOnTop(false);
      win.setMinimumSize(1024, 720);
      if (expandedBounds) win.setBounds(expandedBounds, true);
      else win.setSize(1420, 920, true);
      expandedBounds = null;
    }
    return true;
  });
  ipcMain.removeHandler('zhimian:set-content-protection');
  ipcMain.handle('zhimian:set-content-protection', (event, enabled) => {
    if (event.sender !== win.webContents || process.platform !== 'win32' || typeof enabled !== 'boolean') return false;
    win.setContentProtection(enabled);
    return win.isContentProtected();
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'win32') configureSystemAudioLoopback();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
