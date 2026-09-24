const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = __dirname;
const UPDATE_RETRY_DELAYS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000;
let port = 4173;
let mainWindow = null;
let recoveryTimer = null;
let recoveryInProgress = false;
let updateCheckPromise = null;
let updateRetryAttempt = 0;
let updateRetryTimer = null;
let updateIntervalTimer = null;
let updateState = {
  supported: !!app.isPackaged,
  phase: app.isPackaged ? 'idle' : 'unsupported',
  status: app.isPackaged ? '尚未检查更新。' : '当前为开发版或网页版，无需检查安装更新。',
  version: app.getVersion(),
  availableVersion: '',
  checkedAt: 0,
  percent: 0,
  error: ''
};

// Disable the GPU path that commonly causes a blank Electron surface on some Windows drivers.
app.disableHardwareAcceleration();

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

function canBind(candidate) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function choosePort() {
  for (let candidate = 4173; candidate <= 4190; candidate += 1) {
    if (await health(candidate)) continue;
    if (await canBind(candidate)) return candidate;
  }
  throw new Error('没有可用的本地端口（4173-4190 均被占用）。');
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

function updateSnapshot() {
  return { ...updateState, version: app.getVersion() };
}

function publishUpdateState(patch = {}) {
  updateState = { ...updateState, ...patch, version: app.getVersion() };
  const snapshot = updateSnapshot();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('workbench:update-status-changed', snapshot);
  }
  return snapshot;
}

function readableUpdateError(error) {
  const detail = String(error?.message || error || '未知错误').trim();
  if (/ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|ERR_CONNECTION|network|socket hang up|fetch failed|certificate|getaddrinfo/i.test(detail)) {
    return '网络连接失败，请检查网络或代理后重试。';
  }
  if (/403|forbidden|rate limit/i.test(detail)) return '更新服务暂时不可用，请稍后重试。';
  if (/404|not found|channel file/i.test(detail)) return '未找到可用的更新文件，请稍后重试。';
  return detail.length > 220 ? `${detail.slice(0, 220)}…` : detail;
}

function clearUpdateRetry() {
  if (updateRetryTimer) clearTimeout(updateRetryTimer);
  updateRetryTimer = null;
}

function scheduleUpdateRetry() {
  if (!app.isPackaged || app.isQuitting || updateRetryAttempt >= UPDATE_RETRY_DELAYS.length) return;
  clearUpdateRetry();
  const delay = UPDATE_RETRY_DELAYS[updateRetryAttempt];
  updateRetryAttempt += 1;
  updateRetryTimer = setTimeout(() => {
    updateRetryTimer = null;
    if (!app.isQuitting) performUpdateCheck(false);
  }, delay);
}

async function performUpdateCheck(manual = false) {
  if (!app.isPackaged) {
    return publishUpdateState({
      supported: false,
      phase: 'unsupported',
      status: '当前为开发版或网页版，无需检查安装更新。',
      availableVersion: '',
      error: ''
    });
  }
  if (updateCheckPromise) return updateCheckPromise;
  clearUpdateRetry();
  publishUpdateState({
    supported: true,
    phase: 'checking',
    status: manual ? '正在检查更新…' : '正在后台检查更新…',
    error: ''
  });
  updateCheckPromise = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result?.isUpdateAvailable) {
        updateRetryAttempt = 0;
        return publishUpdateState({
          supported: true,
          phase: 'available',
          status: `发现新版本 ${result.updateInfo.version}，等待确认下载。`,
          availableVersion: result.updateInfo.version,
          checkedAt: Date.now(),
          error: ''
        });
      }
      updateRetryAttempt = 0;
      if (!result) {
        return publishUpdateState({
          supported: true,
          phase: manual ? 'error' : 'idle',
          status: '更新服务暂时没有返回结果，请稍后重试。',
          checkedAt: Date.now(),
          error: 'no result'
        });
      }
      return publishUpdateState({
        supported: true,
        phase: 'current',
        status: '已是最新版本。',
        availableVersion: '',
        checkedAt: Date.now(),
        error: ''
      });
    } catch (error) {
      const message = readableUpdateError(error);
      publishUpdateState({
        supported: true,
        phase: 'error',
        status: `检查更新失败：${message}`,
        checkedAt: Date.now(),
        error: message
      });
      scheduleUpdateRetry();
      return updateSnapshot();
    } finally {
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

function startUpdateChecks() {
  if (!app.isPackaged) return;
  updateState = { ...updateState, supported: true, phase: 'idle', status: '尚未检查更新。' };
  setTimeout(() => {
    if (!app.isQuitting) performUpdateCheck(false);
  }, 8000);
  updateIntervalTimer = setInterval(() => {
    if (!app.isQuitting) performUpdateCheck(false);
  }, UPDATE_CHECK_INTERVAL);
}

async function createWindow() {
  port = await choosePort();
  startServer();
  await waitForServer();
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
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  let closeAllowed = false, confirmingClose = false, savingBeforeClose = false;
  const flushBeforeClose = async () => {
    let timeout;
    try {
      await Promise.race([
        win.webContents.executeJavaScript(`(async () => {
          if(document.readyState==='loading') await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
          if(!window.workbenchState) throw new Error('历史记录保存服务尚未就绪');
          return window.workbenchState.flush();
        })()`),
        new Promise((_, reject) => {timeout = setTimeout(() => reject(new Error('保存超时，请稍后重试')), 20000);})
      ]);
    } finally { clearTimeout(timeout); }
  };
  win.on('close', async event => {
    if (closeAllowed || app.isQuitting) return;
    event.preventDefault();
    if (confirmingClose || savingBeforeClose) return;
    confirmingClose = true;
    let response;
    try {
      ({ response } = await dialog.showMessageBox(win, {
        type: 'question',
        title: '关闭谢梦雄创作台',
        message: '确定要退出工作台吗？',
        detail: '退出前会自动保存历史记录与当前编辑内容。',
        buttons: ['退出', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      }));
    } finally { confirmingClose = false; }
    if (response !== 0 || win.isDestroyed()) return;
    if (savingBeforeClose) return;
    savingBeforeClose = true;
    win.setTitle('谢梦雄创作台 - 正在保存历史记录…');
    try {
      await flushBeforeClose();
      closeAllowed = true;
      clearTimeout(recoveryTimer);
      win.close();
    } catch (error) {
      app.isQuitting = false;
      win.setTitle('谢梦雄创作台');
      await dialog.showMessageBox(win, {type:'error', title:'历史记录尚未保存', message:'为防止任务记录丢失，本次未退出软件。', detail:`${error.message}\n请检查磁盘空间后再次关闭。`, buttons:['返回工作台']});
    } finally { savingBeforeClose = false; }
  });
  const loadWorkbench = () => win.loadURL(`http://127.0.0.1:${port}/?desktop=1&recovery=${Date.now()}`);
  const recoverRenderer = reason => {
    if (win.isDestroyed() || recoveryInProgress) return;
    recoveryInProgress = true;
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(async () => {
      try { win.webContents.stop(); } catch {}
      try { await loadWorkbench(); } catch (error) { console.warn(`工作台恢复失败（${reason}）:`, error.message); }
      recoveryInProgress = false;
    }, reason === 'gone' ? 700 : 1200);
  };
  loadWorkbench();
  win.webContents.on('render-process-gone', (_event, details) => recoverRenderer(details?.reason || 'gone'));
  // A slow popup/layout is not a crashed renderer. Reloading here discards edits
  // and can fire even after Chromium has already become responsive again.
  win.webContents.on('unresponsive', () => console.warn('工作台暂时繁忙，保留当前编辑状态，等待响应。'));
  win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) recoverRenderer(`load:${description}`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (app.isPackaged) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('update-available', info => {
      updateRetryAttempt = 0;
      clearUpdateRetry();
      publishUpdateState({
        supported: true,
        phase: 'available',
        status: `发现新版本 ${info.version}，是否立即下载？`,
        availableVersion: info.version,
        checkedAt: Date.now(),
        error: ''
      });
      dialog.showMessageBox(win, { type: 'info', title: '发现新版本', message: `发现新版本 ${info.version}，是否立即下载？`, buttons: ['立即下载', '稍后'], defaultId: 0, cancelId: 1, noLink: true }).then(({ response }) => {
        if (response === 0 && !win.isDestroyed()) {
          publishUpdateState({ phase: 'downloading', status: '正在下载更新 0%', percent: 0 });
          autoUpdater.downloadUpdate().catch(() => {});
        } else {
          publishUpdateState({ phase: 'available', status: `发现新版本 ${info.version}，已选择稍后。` });
        }
      }).catch(error => publishUpdateState({ phase: 'error', status: `更新提示失败：${readableUpdateError(error)}` }));
    });
    autoUpdater.on('download-progress', progress => {
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      if (!win.isDestroyed()) {
        win.setProgressBar(percent / 100);
        win.setTitle(`谢梦雄创作台 - 正在下载更新 ${percent.toFixed(0)}%`);
      }
      publishUpdateState({ phase: 'downloading', status: `正在下载更新 ${percent.toFixed(0)}%`, percent, error: '' });
    });
    autoUpdater.on('update-downloaded', () => {
      if (!win.isDestroyed()) {
        win.setProgressBar(-1);
        win.setTitle('谢梦雄创作台');
      }
      publishUpdateState({ phase: 'downloaded', status: '新版本已下载，重启后即可完成更新。', percent: 100, error: '' });
      dialog.showMessageBox(win, { type: 'info', title: '更新已下载', message: '新版本已下载完成，重启工作台即可完成更新。', buttons: ['立即重启', '稍后'], defaultId: 0, cancelId: 1, noLink: true }).then(({ response }) => {
        if (response === 0) {
          flushBeforeClose().then(() => { closeAllowed = true; autoUpdater.quitAndInstall(); })
            .catch(error => dialog.showMessageBox(win, {type:'error', message:'历史记录尚未保存，暂未重启更新。', detail:error.message}));
        }
      });
    });
    autoUpdater.on('update-not-available', () => {
      updateRetryAttempt = 0;
      clearUpdateRetry();
      publishUpdateState({ supported: true, phase: 'current', status: '已是最新版本。', availableVersion: '', checkedAt: Date.now(), error: '' });
    });
    autoUpdater.on('error', error => {
      if (!win.isDestroyed()) {
        win.setProgressBar(-1);
        win.setTitle('谢梦雄创作台');
      }
      const message = readableUpdateError(error);
      publishUpdateState({ phase: 'error', status: `更新失败：${message}`, checkedAt: Date.now(), error: message });
      console.warn('自动更新失败:', error.message);
    });
    startUpdateChecks();
  }
}

ipcMain.handle('workbench:update-status', () => updateSnapshot());
ipcMain.handle('workbench:check-update', () => performUpdateCheck(true));

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
else app.whenReady().then(() => createWindow().catch(error => {
  console.error(error);
  dialog.showErrorBox('谢梦雄创作台启动失败', `本地服务无法启动：${error.message}`);
  app.quit();
}));
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {if (win.isMinimized()) win.restore();win.show();win.focus();}
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  app.isQuitting = true;
  clearUpdateRetry();
  if (updateIntervalTimer) clearInterval(updateIntervalTimer);
  updateIntervalTimer = null;
});
