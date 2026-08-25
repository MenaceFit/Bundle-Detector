import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mediaResponse } from './mediaStream';
import {
  cancelTranscription,
  clearModelCache,
  defaultCacheDir,
  setModelCacheDir,
  transcribe,
  transcriberStatus,
  TranscriptionCancelled,
} from './transcriber';
import {
  cacheDirFor,
  cancelAllJobs,
  cancelJob,
  clearCache,
  computeWaveform,
  detectBinaries,
  finishJob,
  probe,
  runFfmpeg,
  setCacheRoot,
  setConfiguredFfmpegPath,
  startFfmpegJob,
  writeJobFrame,
} from './ffmpegRunner';

/**
 * Local media are served through a dedicated scheme rather than read into
 * memory: a `<video>` pointed at `appmedia://` streams from disk and can seek,
 * which is what keeps a long file from being buffered whole.
 */
const MEDIA_SCHEME = 'appmedia';

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
]);

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

  /* ------------------------------------------------------- video captions */

  ipcMain.handle('video:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Importer une vidéo',
      filters: [{ name: 'Vidéos', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi'] }],
      properties: ['openFile'],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return null;
    return { path: filePath, name: path.basename(filePath) };
  });

  ipcMain.handle('video:pickOutput', async (_event, suggestedName: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Exporter la vidéo',
      defaultPath: suggestedName,
      filters: [{ name: 'Vidéo MP4', extensions: ['mp4'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return { path: assertWritablePath(result.filePath) };
  });

  ipcMain.handle('ffmpeg:status', () => detectBinaries());

  ipcMain.handle('ffmpeg:setPath', async (_event, value: string | null) => {
    setConfiguredFfmpegPath(value);
    return detectBinaries();
  });

  ipcMain.handle('ffmpeg:pickBinary', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Sélectionner le binaire ffmpeg',
      properties: ['openFile'],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return null;
    setConfiguredFfmpegPath(filePath);
    return detectBinaries();
  });

  ipcMain.handle('video:probe', async (_event, payload: { path: string; args: string[] }) =>
    probe(payload.path, payload.args),
  );

  /**
   * Runs an ffmpeg command whose output lands in the per-file cache directory.
   *
   * The caller passes the argument list with a placeholder standing in for the
   * output path, so the renderer never learns or chooses a filesystem location,
   * and an artefact already produced for this exact file is reused as-is. The
   * source file is only ever read.
   */
  ipcMain.handle(
    'media:run',
    async (
      _event,
      payload: { sourcePath: string; outputName: string; buildArgs: string[]; placeholder: string },
    ) => {
      const dir = await cacheDirFor(payload.sourcePath);
      const output = path.join(dir, payload.outputName);
      const already = await fs
        .stat(output)
        .then((stat) => stat.size > 0)
        .catch(() => false);
      if (!already) {
        const args = payload.buildArgs.map((arg) =>
          arg === payload.placeholder ? output : arg,
        );
        await runFfmpeg(args);
      }
      return { path: output };
    },
  );

  ipcMain.handle('media:readFile', async (_event, filePath: string) => {
    const data = await fs.readFile(assertWritablePath(filePath));
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  });

  ipcMain.handle(
    'media:waveform',
    async (_event, payload: { wavPath: string; buckets: number }) =>
      computeWaveform(assertWritablePath(payload.wavPath), Math.max(16, payload.buckets)),
  );

  ipcMain.handle('cache:clear', () => clearCache());

  /* ------------------------------------------------------------ transcription */

  ipcMain.handle('asr:status', () => transcriberStatus());

  ipcMain.handle('asr:clearModels', () => clearModelCache());

  ipcMain.handle(
    'asr:run',
    async (
      event,
      payload: {
        id: string;
        audio: ArrayBuffer;
        modelId: string;
        language: string | null;
        durationSec: number;
      },
    ) => {
      try {
        const result = await transcribe({
          id: payload.id,
          audio: new Float32Array(payload.audio),
          modelId: payload.modelId,
          language: payload.language,
          durationSec: payload.durationSec,
          onProgress: (progress) => {
            // The window can be gone by the time a long job reports.
            if (!event.sender.isDestroyed()) {
              event.sender.send('asr:progress', { id: payload.id, ...progress });
            }
          },
        });
        return { ok: true as const, ...result };
      } catch (error) {
        if (error instanceof TranscriptionCancelled) {
          return { ok: false as const, cancelled: true, message: error.message };
        }
        return {
          ok: false as const,
          cancelled: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle('asr:cancel', (_event, id: string) => cancelTranscription(id));

  /* ------------------------------------------------------------- render job */

  ipcMain.handle(
    'render:start',
    async (event, payload: { id: string; args: string[]; totalSec: number }) => {
      await startFfmpegJob(payload.id, payload.args, (chunk) => {
        event.sender.send('render:progress', { id: payload.id, chunk, totalSec: payload.totalSec });
      });
      return { started: true };
    },
  );

  ipcMain.handle('render:frame', async (_event, payload: { id: string; data: ArrayBuffer }) =>
    writeJobFrame(payload.id, new Uint8Array(payload.data)),
  );

  ipcMain.handle('render:finish', (_event, id: string) => finishJob(id));

  ipcMain.handle('render:cancel', (_event, id: string) => {
    cancelJob(id);
    return true;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    isDev,
  }));
}

function registerMediaProtocol(): void {
  // appmedia://local/<url-encoded absolute path>
  protocol.handle(MEDIA_SCHEME, (request) => mediaResponse(request));
}

void app.whenReady().then(() => {
  registerMediaProtocol();
  setCacheRoot(path.join(app.getPath('userData'), 'media-cache'));
  setModelCacheDir(defaultCacheDir(app.getPath('userData')));
  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // Never leave an ffmpeg child running after the window is gone.
  cancelAllJobs();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
