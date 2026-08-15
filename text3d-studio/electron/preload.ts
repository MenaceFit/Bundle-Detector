import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

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

  onMenuCommand: (handler: (command: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, command: string): void => handler(command);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
};

contextBridge.exposeInMainWorld('desktop', desktop);

export type DesktopBridge = typeof desktop;
