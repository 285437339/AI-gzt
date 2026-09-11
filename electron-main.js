const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
let port = 4173;
let mainWindow = null;
let updateState = { supported: false, status: '网页版无需检查安装更新。', version: app.getVersion(), availableVersion: '' };

const stableUserData = path.join(app.getPath('appData'), 'xie-mengxiong-workbench');
if (!fs.existsSync(stableUserData)) {
  const candidates = ['AIwork', '谢梦雄创作台'].map(name => path.join(app.getPath('appData'), name));
  const legacy = candidates.filter(candidate => fs.existsSync(path.join(candidate, 'Local Storage'))).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (legacy) fs.cpSync(legacy, stableUserData, { recursive: true });
}
app.setPath('userData', stableUserData);

function health(candidate) {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port: candidate, path: '/api/health', timeout: 700 }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode === 200));
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function choosePort() {
  for (let candidate = 4173; candidate <= 4190; candidate += 1) {
    if (!(await health(candidate))) return candidate;
  }
  throw new Error('没有可用的本地端口。');
}

function startServer() {
  process.env.AI_WORKBENCH_PORT = String(port);
  require(path.join(ROOT, 'server.js'));
}

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    if (await health(port)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('本地服务启动超时。');
}

async function storageForHost(host) {
  const bridge = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await bridge.loadURL(`http://${host}:${port}/api/storage-bridge`);
    return await bridge.webContents.executeJavaScript('Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>{const key=localStorage.key(i);return [key,localStorage.getItem(key)]}))');
  } finally {
    bridge.destroy();
  }
}

async function migrateOriginStorage() {
  const localhost = await storageForHost('localhost').catch(() => ({}));
  const canonical = await storageForHost('127.0.0.1').catch(() => ({}));
  const merged = { ...localhost, ...canonical };
  if (!Object.keys(merged).length) return;
  const bridge = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await bridge.loadURL(`http://127.0.0.1:${port}/api/storage-bridge`);
    await bridge.webContents.executeJavaScript(`(()=>{const values=${JSON.stringify(merged)};for(const [key,value] of Object.entries(values)){const current=localStorage.getItem(key);if(current===null||current===''||current==='[]'||current==='{}')localStorage.setItem(key,value)}})()`);
  } finally {
    bridge.destroy();
  }
}

async function createWindow() {
  port = await choosePort();
  startServer();
  await waitForServer();
  await migrateOriginStorage();
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#101114',
    title: '谢梦雄创作台',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'preload.js') }
  });
  mainWindow = win;
  win.loadURL(`http://127.0.0.1:${port}/?desktop=1`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (app.isPackaged) {
    updateState = { supported: true, status: '尚未检查更新。', version: app.getVersion(), availableVersion: '' };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('update-available', info => {
      updateState = { ...updateState, status: `发现新版本 ${info.version}，正在下载。`, availableVersion: info.version };
      dialog.showMessageBox(win, { type: 'info', title: '发现新版本', message: `发现新版本 ${info.version}，正在后台下载。` });
    });
    autoUpdater.on('update-downloaded', () => {
      updateState = { ...updateState, status: '新版本已下载，重启后即可完成更新。' };
      dialog.showMessageBox(win, { type: 'info', title: '更新已下载', message: '新版本已下载完成，重启工作台即可完成更新。', buttons: ['立即重启', '稍后'] }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    });
    autoUpdater.on('update-not-available', () => { updateState = { ...updateState, status: '已是最新版本。', availableVersion: '' }; });
    autoUpdater.on('error', error => { updateState = { ...updateState, status: `检查更新失败：${error.message}` }; console.warn('自动更新检查失败:', error.message); });
    setTimeout(() => autoUpdater.checkForUpdates().catch(error => console.warn('自动更新检查失败:', error.message)), 2500);
  }
}

ipcMain.handle('workbench:update-status', () => updateState);
ipcMain.handle('workbench:check-update', async () => {
  if (!app.isPackaged) return { ...updateState, status: '当前为开发版或网页版，无需检查安装更新。' };
  updateState = { ...updateState, status: '正在检查更新…' };
  try { await autoUpdater.checkForUpdates(); } catch (error) { updateState = { ...updateState, status: `检查更新失败：${error.message}` }; }
  return updateState;
});

app.whenReady().then(() => createWindow().catch(error => { console.error(error); app.quit(); }));
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { app.isQuitting = true; });
