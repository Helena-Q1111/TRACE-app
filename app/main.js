// TRACE Visualizer - Electron main process
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 600,
        backgroundColor: '#05050f',
        title: 'TRACE Visualizer',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Read bundled JSON data (chord_table.json etc.) from renderer/data
ipcMain.handle('trace:read-json', (_evt, name) => {
    const p = path.join(__dirname, 'renderer', 'data', path.basename(name));
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
});

// Read bundled binary assets (piano samples) - file:// fetch is blocked in the renderer
ipcMain.handle('trace:read-binary', (_evt, rel) => {
    const base = path.join(__dirname, 'renderer');
    const p = path.normalize(path.join(base, rel));
    if (!p.startsWith(base)) throw new Error('Invalid asset path');
    return fs.readFileSync(p);
});

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
