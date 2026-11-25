const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbenchDesktop', {
  downloadMedia: url => ipcRenderer.invoke('workbench:download-media', url),
  updateStatus: () => ipcRenderer.invoke('workbench:update-status'),
  checkForUpdate: () => ipcRenderer.invoke('workbench:check-update'),
  onUpdateStatus: callback => {
    if (typeof callback === 'function') {
      ipcRenderer.on('workbench:update-status-changed', (_event, state) => callback(state));
    }
  }
});
