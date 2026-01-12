const { contextBridge, ipcRenderer } = require('electron');

// Expose IPC methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer → Main (handlers)
  connect: (target) => ipcRenderer.invoke('rde/connect', { target }),
  disconnect: () => ipcRenderer.invoke('rde/disconnect', {}),
  supervisorStatus: (target) => ipcRenderer.invoke('supervisor/status', { target }),
  supervisorRestart: (target, serviceName) => 
    ipcRenderer.invoke('supervisor/restart', { target, serviceName }),
  supervisorStart: (target, serviceName) => 
    ipcRenderer.invoke('supervisor/start', { target, serviceName }),
  supervisorStop: (target, serviceName) => 
    ipcRenderer.invoke('supervisor/stop', { target, serviceName }),
  supervisorBulk: (target, serviceNames, operation) => 
    ipcRenderer.invoke('supervisor/bulk', { target, serviceNames, operation }),
  logsList: (target) => ipcRenderer.invoke('logs/list', { target }),
  logsTail: (target, files, mode, lines) => 
    ipcRenderer.invoke('logs/tail', { target, files, mode, lines }),
  logsStop: (streamId) => ipcRenderer.invoke('logs/stop', { streamId }),
  executeCommand: (target, command) => 
    ipcRenderer.invoke('command/execute', { target, command }),

  // Main → Renderer (events)
  onRdeStatus: (callback) => {
    ipcRenderer.on('rde/status', (event, data) => callback(data));
  },
  onSupervisorStatusResult: (callback) => {
    ipcRenderer.on('supervisor/statusResult', (event, data) => callback(data));
  },
  onCommandOutput: (callback) => {
    ipcRenderer.on('command/output', (event, data) => callback(data));
  },
  onLogsLine: (callback) => {
    ipcRenderer.on('logs/line', (event, data) => callback(data));
  },
  onLogsStopped: (callback) => {
    ipcRenderer.on('logs/stopped', (event, data) => callback(data));
  },

  // Remove listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});

