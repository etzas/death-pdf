const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');

// On Linux (esp. VMs like AlmaLinux) the GPU path spams benign
// "GetVSyncParametersIfAvailable() failed" errors. Software rendering
// there is plenty fast for a PDF reader and keeps the terminal clean.
// Windows/macOS keep hardware acceleration.
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let pendingFile = null; // file to open once the window is ready
let unsavedChanges = false; // renderer reports when annotations are dirty

ipcMain.on('state:setDirty', (_e, value) => {
  unsavedChanges = !!value;
});

function pdfFromArgs(argv) {
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().endsWith('.pdf')) || null;
}

// Single instance: opening a PDF while the app runs reuses the window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = pdfFromArgs(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (file) mainWindow.webContents.send('open-file-path', file);
    }
  });

  // macOS "open with" delivers files through this event.
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    if (mainWindow) mainWindow.webContents.send('open-file-path', filePath);
    else pendingFile = filePath;
  });

  pendingFile = pdfFromArgs(process.argv);

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#050505',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (pendingFile) {
    const file = pendingFile;
    pendingFile = null;
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('open-file-path', file);
    });
  }

  // Guard against closing with unsaved annotations. Saving is manual
  // (Ctrl+S), so warn instead of silently discarding.
  mainWindow.on('close', (e) => {
    if (!unsavedChanges) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Descartar e sair', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Anotacoes nao salvas',
      message: 'Ha anotacoes nao salvas. Deseja descarta-las e sair?',
    });
    if (choice === 1) e.preventDefault();
    else unsavedChanges = false;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: file operations ----

ipcMain.handle('dialog:openPdf', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Abrir PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  return await readPdf(filePaths[0]);
});

ipcMain.handle('file:readPdf', async (_e, filePath) => readPdf(filePath));

async function readPdf(filePath) {
  const data = await fs.readFile(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  };
}

// Annotations sidecar: <file>.pdf -> <file>.pdf.deathpdf.json
function sidecarFor(pdfPath) {
  return pdfPath + '.deathpdf.json';
}

ipcMain.handle('annotations:load', async (_e, pdfPath) => {
  try {
    const raw = await fs.readFile(sidecarFor(pdfPath), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
});

ipcMain.handle('annotations:save', async (_e, pdfPath, data) => {
  try {
    await fs.writeFile(sidecarFor(pdfPath), JSON.stringify(data), 'utf-8');
    return true;
  } catch (err) {
    return { error: String(err) };
  }
});

ipcMain.handle('window:toggleFullscreen', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});

ipcMain.handle('dialog:exportPdf', async (_e, suggestedName, bytes) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar PDF com anotacoes',
    defaultPath: suggestedName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, Buffer.from(bytes));
  return filePath;
});
