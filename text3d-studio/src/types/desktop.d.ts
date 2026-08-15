export interface DesktopBridge {
  openProject(): Promise<{ filePath: string; content: string } | null>;
  saveProject(payload: {
    filePath: string | null;
    content: string;
    suggestedName: string;
  }): Promise<{ filePath: string } | null>;
  saveBinary(payload: {
    data: ArrayBuffer;
    suggestedName: string;
    extensions: string[];
  }): Promise<{ filePath: string } | null>;
  saveSequence(payload: {
    files: Array<{ name: string; data: ArrayBuffer }>;
    folderName: string;
  }): Promise<{ filePath: string } | null>;
  importFonts(): Promise<Array<{ name: string; data: ArrayBuffer }>>;
  revealFile(filePath: string): Promise<void>;
  appInfo(): Promise<{ version: string; platform: string; isDev: boolean }>;
  onMenuCommand(handler: (command: string) => void): () => void;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
    /** Local Font Access API — available in Electron and Chromium desktop. */
    queryLocalFonts?: () => Promise<Array<{ family: string; fullName: string; style: string }>>;
  }
}

export {};
