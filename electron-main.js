const { app, BrowserWindow, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = __dirname;
let port = 4173;
let recoveryTimer = null;
let recoveryInProgress = false;

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
  let closeAllowed = false, savingBeforeClose = false;
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
  win.on('close', event => {
    if (closeAllowed) return;
    event.preventDefault();
    if (savingBeforeClose) return;
    savingBeforeClose = true;
    win.setTitle('谢梦雄创作台 - 正在保存历史记录…');
    flushBeforeClose().then(() => {
      closeAllowed = true;
      clearTimeout(recoveryTimer);
      win.close();
    }).catch(async error => {
      app.isQuitting = false;
      win.setTitle('谢梦雄创作台');
      await dialog.showMessageBox(win, {type:'error', title:'历史记录尚未保存', message:'为防止任务记录丢失，本次未退出软件。', detail:`${error.message}\n请检查磁盘空间后再次关闭。`, buttons:['返回工作台']});
    }).finally(() => {savingBeforeClose = false;});
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
      dialog.showMessageBox(win, { type: 'info', title: '发现新版本', message: `发现新版本 ${info.version}，是否立即下载？`, buttons: ['立即下载', '稍后'] }).then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
      });
    });
    autoUpdater.on('download-progress', progress => {
      win.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
      win.setTitle(`谢梦雄创作台 - 正在下载更新 ${progress.percent.toFixed(0)}%`);
    });
    autoUpdater.on('update-downloaded', () => {
      win.setProgressBar(-1);
      win.setTitle('谢梦雄创作台');
      dialog.showMessageBox(win, { type: 'info', title: '更新已下载', message: '新版本已下载完成，重启工作台即可完成更新。', buttons: ['立即重启', '稍后'] }).then(({ response }) => {
        if (response === 0) {
          flushBeforeClose().then(() => { closeAllowed = true; autoUpdater.quitAndInstall(); })
            .catch(error => dialog.showMessageBox(win, {type:'error', message:'历史记录尚未保存，暂未重启更新。', detail:error.message}));
        }
      });
    });
    autoUpdater.on('error', error => { win.setProgressBar(-1); win.setTitle('谢梦雄创作台'); console.warn('自动更新检查失败:', error.message); });
    setTimeout(() => autoUpdater.checkForUpdates().catch(error => console.warn('自动更新检查失败:', error.message)), 2500);
  }
}

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
app.on('before-quit', () => { app.isQuitting = true; });
