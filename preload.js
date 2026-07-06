const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dpdf', {
  openPdf: () => ipcRenderer.invoke('dialog:openPdf'),
  readPdf: (filePath) => ipcRenderer.invoke('file:readPdf', filePath),
  loadAnnotations: (pdfPath) => ipcRenderer.invoke('annotations:load', pdfPath),
  saveAnnotations: (pdfPath, data) =>
    ipcRenderer.invoke('annotations:save', pdfPath, data),
  exportPdf: (name, bytes) => ipcRenderer.invoke('dialog:exportPdf', name, bytes),
  onOpenFilePath: (cb) =>
    ipcRenderer.on('open-file-path', (_e, p) => cb(p)),
});
