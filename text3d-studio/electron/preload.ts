import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

export interface FfmpegStatus {
  available: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  version: string | null;
  source: 'bundled' | 'system' | 'configured' | 'none';
  error?: string;
}

/**
 * The only surface the renderer gets. Every method is an explicit, typed call
 * into a whitelisted IPC channel — no `ipcRenderer`, no `require`, no Node.
 */
const desktop = {
  openProject: (): Promise<{ filePath: string; content: string } | null> =>
    ipcRenderer.invoke('project:open'),

  saveProject: (payload: {
    filePath: string | null;
    content: string;
    suggestedName: string;
  }): Promise<{ filePath: string } | null> => ipcRenderer.invoke('project:save', payload),

  saveBinary: (payload: {
    data: ArrayBuffer;
    suggestedName: string;
    extensions: string[];
  }): Promise<{ filePath: string } | null> => ipcRenderer.invoke('file:saveBinary', payload),

  saveSequence: (payload: {
    files: Array<{ name: string; data: ArrayBuffer }>;
    folderName: string;
  }): Promise<{ filePath: string } | null> => ipcRenderer.invoke('file:saveSequence', payload),

  importFonts: (): Promise<Array<{ name: string; data: ArrayBuffer }>> =>
    ipcRenderer.invoke('font:import'),

  revealFile: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:revealFile', filePath),

  appInfo: (): Promise<{ version: string; platform: string; isDev: boolean }> =>
    ipcRenderer.invoke('app:info'),

  /* ------------------------------------------------------- video captions */

  video: {
    pick: (): Promise<{ path: string; name: string } | null> => ipcRenderer.invoke('video:pick'),

    pickOutput: (suggestedName: string): Promise<{ path: string } | null> =>
      ipcRenderer.invoke('video:pickOutput', suggestedName),

    probe: (payload: { path: string; args: string[] }): Promise<string> =>
      ipcRenderer.invoke('video:probe', payload),

    /**
     * Runs a cached ffmpeg derivation. `placeholder` marks where the main
     * process substitutes the real output path inside `buildArgs`.
     */
    derive: (payload: {
      sourcePath: string;
      outputName: string;
      buildArgs: string[];
      placeholder: string;
    }): Promise<{ path: string }> => ipcRenderer.invoke('media:run', payload),

    readFile: (filePath: string): Promise<ArrayBuffer> =>
      ipcRenderer.invoke('media:readFile', filePath),

    waveform: (payload: { wavPath: string; buckets: number }): Promise<number[]> =>
      ipcRenderer.invoke('media:waveform', payload),

    clearCache: (): Promise<void> => ipcRenderer.invoke('cache:clear'),
  },

  /**
   * Local speech recognition. Inference runs in the main process with native
   * ONNX Runtime; the renderer only sends samples and receives words.
   */
  asr: {
    status: (): Promise<{ available: boolean; error?: string; cacheDir?: string }> =>
      ipcRenderer.invoke('asr:status'),

    run: (payload: {
      id: string;
      audio: ArrayBuffer;
      modelId: string;
      language: string | null;
      durationSec: number;
    }): Promise<
      | { ok: true; chunks: Array<{ text: string; timestamp: [number, number | null] }>; text: string }
      | { ok: false; cancelled: boolean; message: string }
    > => ipcRenderer.invoke('asr:run', payload),

    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke('asr:cancel', id),

    clearModels: (): Promise<void> => ipcRenderer.invoke('asr:clearModels'),

    onProgress: (
      handler: (payload: {
        id: string;
        stage: 'loadingModel' | 'transcribing';
        ratio: number | null;
        message: string;
      }) => void,
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: {
          id: string;
          stage: 'loadingModel' | 'transcribing';
          ratio: number | null;
          message: string;
        },
      ): void => handler(payload);
      ipcRenderer.on('asr:progress', listener);
      return () => ipcRenderer.removeListener('asr:progress', listener);
    },
  },

  ffmpeg: {
    status: (): Promise<FfmpegStatus> => ipcRenderer.invoke('ffmpeg:status'),
    setPath: (value: string | null): Promise<FfmpegStatus> =>
      ipcRenderer.invoke('ffmpeg:setPath', value),
    pickBinary: (): Promise<FfmpegStatus | null> => ipcRenderer.invoke('ffmpeg:pickBinary'),
  },

  render: {
    start: (payload: { id: string; args: string[]; totalSec: number }): Promise<{ started: boolean }> =>
      ipcRenderer.invoke('render:start', payload),

    /** Resolves false once ffmpeg stops accepting frames. */
    frame: (payload: { id: string; data: ArrayBuffer }): Promise<boolean> =>
      ipcRenderer.invoke('render:frame', payload),

    finish: (id: string): Promise<{ ok: boolean; code: number | null; stderr: string }> =>
      ipcRenderer.invoke('render:finish', id),

    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke('render:cancel', id),

    onProgress: (
      handler: (payload: { id: string; chunk: string; totalSec: number }) => void,
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: { id: string; chunk: string; totalSec: number },
      ): void => handler(payload);
      ipcRenderer.on('render:progress', listener);
      return () => ipcRenderer.removeListener('render:progress', listener);
    },
  },

  onMenuCommand: (handler: (command: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, command: string): void => handler(command);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
};

contextBridge.exposeInMainWorld('desktop', desktop);

// Dropping a file only yields a real path through webUtils in current Electron.
contextBridge.exposeInMainWorld('webUtils', {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
});

export type DesktopBridge = typeof desktop;
