import path from 'node:path';

/**
 * Translation between filesystem paths and the `appmedia://` URLs the preview
 * player streams from.
 *
 * The renderer builds the URL (see `src/videoproject/playback.ts`) and the main
 * process decodes it here. Both halves live in one file so they cannot drift,
 * and so the Windows cases — drive letters and UNC shares — are stated once.
 */

/** Content type sent with a streamed file, picked from its extension. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function mediaMimeType(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/**
 * Decodes the pathname of an `appmedia://` URL back into a filesystem path.
 *
 * A URL pathname always starts with `/`, so a Windows path arrives as
 * `/C:/Users/…`. Handing that to `path.resolve` anchors it to the root of the
 * current drive and yields `C:\C:\Users\…`, which is why the leading slash is
 * removed before a drive letter — the single reason the preview could not open
 * any file on Windows.
 */
export function decodeMediaPath(pathname: string): string {
  const decoded = decodeURIComponent(pathname);

  // A UNC share (`\\server\share\file`) survives as a double slash.
  if (decoded.startsWith('//')) {
    return path.sep === '\\' ? decoded.replace(/\//g, '\\') : decoded;
  }

  return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

/** True for a path this process is willing to stream to the renderer. */
export function isStreamablePath(filePath: string): boolean {
  if (filePath.length === 0) return false;
  if (filePath.includes('\0')) return false;
  return path.isAbsolute(filePath) || /^[a-zA-Z]:[\\/]/.test(filePath);
}

/**
 * Parses an HTTP `Range` header for a resource of `size` bytes.
 *
 * Only the single-range form is honoured, which is all a media element ever
 * sends. Returns null when the header is absent or unusable, meaning "send the
 * whole file".
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // "bytes=-N" asks for the last N bytes.
  if (rawStart === '') {
    const length = Math.min(size, Number(rawEnd));
    if (!Number.isFinite(length) || length <= 0) return null;
    return { start: size - length, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = rawEnd === '' ? size - 1 : Math.min(size - 1, Number(rawEnd));
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}
