import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { decodeMediaPath, isStreamablePath, mediaMimeType, parseRange } from './mediaPath';

/**
 * Serves a local file to the renderer over the `appmedia://` scheme.
 *
 * Ranges are answered by hand rather than delegated: a media element seeks by
 * asking for byte ranges, and without a correct `206` it either refuses to
 * start or cannot be moved in the timeline. Nothing here writes — the source
 * file is opened read-only, exactly like every other path that touches it.
 */
export async function mediaResponse(request: {
  url: string;
  method: string;
  headers: { get: (name: string) => string | null };
}): Promise<Response> {
  let filePath: string;
  try {
    filePath = decodeMediaPath(new URL(request.url).pathname);
  } catch {
    return new Response('Adresse illisible', { status: 400 });
  }
  if (!isStreamablePath(filePath)) {
    return new Response('Chemin invalide', { status: 400 });
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    return new Response('Fichier introuvable', { status: 404 });
  }

  const headers = new Headers({
    'Content-Type': mediaMimeType(filePath),
    'Accept-Ranges': 'bytes',
    // The cache would otherwise keep serving a stale proxy after a re-import.
    'Cache-Control': 'no-store',
  });

  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(stat.size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRange(request.headers.get('range'), stat.size);
  if (!range) {
    headers.set('Content-Length', String(stat.size));
    return new Response(toWebStream(createReadStream(filePath)), { status: 200, headers });
  }

  headers.set('Content-Length', String(range.end - range.start + 1));
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
  return new Response(
    toWebStream(createReadStream(filePath, { start: range.start, end: range.end })),
    { status: 206, headers },
  );
}

function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}
