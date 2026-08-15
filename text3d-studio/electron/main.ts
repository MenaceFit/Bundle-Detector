import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const isDev = Boolean(DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;

/** Menu actions are forwarded to the renderer, which owns all document state. */
function sendMenuCommand(command: string): void {
  mainWindow?.webContents.send('menu:command', command);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d0f14',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security: the renderer never touches Node directly.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // External links open in the system browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: 'Fichier',
      submenu: [
        { label: 'Nouveau', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand('new') },
        { label: 'Ouvrir…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand('open') },
        { type: 'separator' },
        { label: 'Sauvegarder', accelerator: 'CmdOrCtrl+S', click: () => sendMenuCommand('save') },
        {
          label: 'Sauvegarder sous…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendMenuCommand('saveAs'),
        },
        { type: 'separator' },
        { label: 'Exporter…', accelerator: 'CmdOrCtrl+E', click: () => sendMenuCommand('export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { label: 'Annuler', accelerator: 'CmdOrCtrl+Z', click: () => sendMenuCommand('undo') },
        { label: 'Rétablir', accelerator: 'CmdOrCtrl+Y', click: () => sendMenuCommand('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Rejects paths that escape into something we were not asked to touch. */
function assertWritablePath(target: string): string {
  const resolved = path.resolve(target);
  if (!path.isAbsolute(resolved)) {
    throw new Error('Chemin invalide');
  }
  return resolved;
}

function registerIpc(): void {
  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Ouvrir un projet',
      filters: [{ name: 'Projet Text3D', extensions: ['json'] }],
      properties: ['openFile'],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return null;
    const content = await fs.readFile(filePath, 'utf8');
    return { filePath, content };
  });

  ipcMain.handle(
    'project:save',
    async (_event, payload: { filePath: string | null; content: string; suggestedName: string }) => {
      let target = payload.filePath;
      if (!target) {
        const result = await dialog.showSaveDialog({
          title: 'Sauvegarder le projet',
          defaultPath: payload.suggestedName,
          filters: [{ name: 'Projet Text3D', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return null;
        target = result.filePath;
      }
      const resolved = assertWritablePath(target);
      await fs.writeFile(resolved, payload.content, 'utf8');
      return { filePath: resolved };
    },
  );

  ipcMain.handle(
    'file:saveBinary',
    async (_event, payload: { data: ArrayBuffer; suggestedName: string; extensions: string[] }) => {
      const result = await dialog.showSaveDialog({
        title: 'Exporter',
        defaultPath: payload.suggestedName,
        filters: [{ name: 'Fichier', extensions: payload.extensions }],
      });
      if (result.canceled || !result.filePath) return null;
      const resolved = assertWritablePath(result.filePath);
      await fs.writeFile(resolved, Buffer.from(payload.data));
      return { filePath: resolved };
    },
  );

  ipcMain.handle(
    'file:saveSequence',
    async (
      _event,
      payload: { files: Array<{ name: string; data: ArrayBuffer }>; folderName: string },
    ) => {
      const result = await dialog.showOpenDialog({
        title: 'Choisir un dossier de destination',
        properties: ['openDirectory', 'createDirectory'],
      });
      const chosen = result.filePaths[0];
      if (result.canceled || !chosen) return null;
      const outDir = assertWritablePath(path.join(chosen, payload.folderName));
      await fs.mkdir(outDir, { recursive: true });
      for (const file of payload.files) {
        // basename() prevents a crafted frame name from writing outside outDir.
        await fs.writeFile(path.join(outDir, path.basename(file.name)), Buffer.from(file.data));
      }
      return { filePath: outDir };
    },
  );

  ipcMain.handle('font:import', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Importer des polices',
      filters: [{ name: 'Polices', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return Promise.all(
      result.filePaths.map(async (filePath) => ({
        name: path.basename(filePath, path.extname(filePath)),
        data: (await fs.readFile(filePath)).buffer,
      })),
    );
  });

  ipcMain.handle('shell:revealFile', (_event, filePath: string) => {
    shell.showItemInFolder(assertWritablePath(filePath));
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    isDev,
  }));
}

void app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
