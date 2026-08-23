export interface FfmpegStatus {
  available: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  version: string | null;
  source: 'bundled' | 'system' | 'configured' | 'none';
  error?: string;
}

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
  video?: {
    pick(): Promise<{ path: string; name: string } | null>;
    pickOutput(suggestedName: string): Promise<{ path: string } | null>;
    probe(payload: { path: string; args: string[] }): Promise<string>;
    derive(payload: {
      sourcePath: string;
      outputName: string;
      buildArgs: string[];
      placeholder: string;
    }): Promise<{ path: string }>;
    readFile(filePath: string): Promise<ArrayBuffer>;
    waveform(payload: { wavPath: string; buckets: number }): Promise<number[]>;
    clearCache(): Promise<void>;
  };
  ffmpeg?: {
    status(): Promise<FfmpegStatus>;
    setPath(value: string | null): Promise<FfmpegStatus>;
    pickBinary(): Promise<FfmpegStatus | null>;
  };
  render?: {
    start(payload: { id: string; args: string[]; totalSec: number }): Promise<{ started: boolean }>;
    frame(payload: { id: string; data: ArrayBuffer }): Promise<boolean>;
    finish(id: string): Promise<{ ok: boolean; code: number | null; stderr: string }>;
    cancel(id: string): Promise<boolean>;
    onProgress(
      handler: (payload: { id: string; chunk: string; totalSec: number }) => void,
    ): () => void;
  };

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
