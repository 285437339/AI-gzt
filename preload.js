const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbenchDesktop', {
  updateStatus: () => ipcRenderer.invoke('workbench:update-status'),
  checkForUpdate: () => ipcRenderer.invoke('workbench:check-update')
});
