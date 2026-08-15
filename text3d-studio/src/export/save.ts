import { createLogger } from '@/utils/logger';

const log = createLogger('export:save');

export interface SaveResult {
  fileName: string;
  filePath: string | null;
  size: number;
}

/**
 * Writes a blob to disk. On the desktop build this opens a native save dialog
 * through the preload bridge; in a browser it falls back to a download.
 * Returns `null` when the user cancels.
 */
export async function saveBlob(
  blob: Blob,
  fileName: string,
  extensions: string[],
): Promise<SaveResult | null> {
  if (window.desktop) {
    const buffer = await blob.arrayBuffer();
    const result = await window.desktop.saveBinary({
      data: buffer,
      suggestedName: fileName,
      extensions,
    });
    if (!result) return null;
    log.info('Fichier écrit', { path: result.filePath, size: blob.size });
    return { fileName, filePath: result.filePath, size: blob.size };
  }

  downloadBlob(blob, fileName);
  return { fileName, filePath: null, size: blob.size };
}

/** Writes a set of frames next to each other: a folder on desktop, a zip on web. */
export async function saveFrames(
  frames: Array<{ name: string; data: Uint8Array }>,
  folderName: string,
  zipBuilder: () => Blob,
): Promise<SaveResult | null> {
  const totalSize = frames.reduce((sum, frame) => sum + frame.data.length, 0);

  if (window.desktop) {
    const result = await window.desktop.saveSequence({
      files: frames.map((frame) => ({
        name: frame.name,
        data: toArrayBuffer(frame.data),
      })),
      folderName,
    });
    if (!result) return null;
    return { fileName: folderName, filePath: result.filePath, size: totalSize };
  }

  const zip = zipBuilder();
  downloadBlob(zip, `${folderName}.zip`);
  return { fileName: `${folderName}.zip`, filePath: null, size: zip.size };
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Copies into a standalone ArrayBuffer, which is what structured clone needs. */
export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}
