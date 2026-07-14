const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('traceAPI', {
    readJSON: (name) => ipcRenderer.invoke('trace:read-json', name),
    readBinary: (rel) => ipcRenderer.invoke('trace:read-binary', rel)
});
