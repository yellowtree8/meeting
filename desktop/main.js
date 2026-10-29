'use strict';

const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

let gatewayProcess = null;

function startAsrGateway() {
  const appPath = app.getAppPath();
  const gatewayDir = path.join(appPath, 'gateway');
  const serverPath = path.join(gatewayDir, 'server.js');
  let envPath = path.join(gatewayDir, '.env');

  // Packaged apps keep editable credentials in the per-user data directory;
  // never bundle the developer's Tencent secrets into the installer.
  if (app.isPackaged) {
    const userGatewayDir = path.join(app.getPath('userData'), 'gateway');
    envPath = path.join(userGatewayDir, '.env');
    fs.mkdirSync(userGatewayDir, { recursive: true });
    if (!fs.existsSync(envPath)) {
      const examplePath = path.join(gatewayDir, '.env.example');
      if (fs.existsSync(examplePath)) fs.copyFileSync(examplePath, envPath);
      console.warn(`[gateway] 首次运行，请在此文件填写腾讯云凭据：${envPath}`);
    }
  }

  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ASR_GATEWAY_ENV_FILE: envPath };
  try {
    gatewayProcess = spawn(process.execPath, [serverPath], {
      cwd: app.isPackaged ? app.getPath('userData') : gatewayDir,
      env: childEnv,
      windowsHide: true,
      stdio: 'ignore',
    });
    gatewayProcess.once('error', (error) => {
      console.error('[gateway] 无法启动本地 ASR 网关：', error.message);
      gatewayProcess = null;
    });
    gatewayProcess.once('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`[gateway] 进程已退出，代码 ${code}`);
      gatewayProcess = null;
    });
  } catch (error) {
    console.error('[gateway] 无法启动本地 ASR 网关：', error.message);
  }
}

function stopAsrGateway() {
  if (gatewayProcess && !gatewayProcess.killed) gatewayProcess.kill();
  gatewayProcess = null;
}

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
    title: '自定义工具',
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
  if (process.platform === 'win32') {
    configureSystemAudioLoopback();
    startAsrGateway();
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopAsrGateway);
