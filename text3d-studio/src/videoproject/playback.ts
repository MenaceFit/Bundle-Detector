import type { VideoMetadata } from '@/captions/types';

/**
 * Everything the preview player needs to know before it points a `<video>` at a
 * file on disk.
 *
 * Two facts drive this module. A local file is reachable only through the
 * `appmedia://` scheme registered by the main process, and the browser engine
 * inside Electron plays a much narrower set of codecs than FFmpeg reads — HEVC,
 * ProRes, MKV and friends decode perfectly for the export while the preview
 * stays black. So the source is checked up front, and anything the player
 * cannot open is transcoded once into a cached H.264 proxy.
 */

/**
 * Builds the URL a media element streams from.
 *
 * Each path segment is encoded separately so that `#`, `?`, `%` and spaces in a
 * file name survive, and the drive letter of a Windows path keeps its colon.
 * `electron/mediaPath.ts` performs the exact inverse.
 */
export function mediaUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const unc = normalized.startsWith('//');
  const encoded = normalized
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `appmedia://local/${unc ? '/' : ''}${encoded}`;
}

/* ------------------------------------------------------- codec support */

/**
 * Representative codec strings for `canPlayType`.
 *
 * The exact profile matters less than the family: the question asked is "can
 * this engine decode h264 / hevc / av1 at all", and a baseline string answers
 * it without having to parse the bitstream.
 */
const VIDEO_CODEC_IDS: Record<string, string> = {
  h264: 'avc1.42E01E',
  avc1: 'avc1.42E01E',
  hevc: 'hev1.1.6.L93.B0',
  h265: 'hev1.1.6.L93.B0',
  vp8: 'vp8',
  vp9: 'vp09.00.10.08',
  av1: 'av01.0.04M.08',
  theora: 'theora',
};

const AUDIO_CODEC_IDS: Record<string, string> = {
  aac: 'mp4a.40.2',
  mp3: 'mp3',
  mp3float: 'mp3',
  opus: 'opus',
  vorbis: 'vorbis',
  flac: 'flac',
};

/** Containers the engine opens at all, by file extension. */
const CONTAINER_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
};

export type PlaybackSupport = 'probably' | 'maybe' | 'no';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Asks the engine whether it can play this exact file, without loading it.
 *
 * `canPlayType` is the browser's own answer, so no codec table maintained here
 * can contradict a build that does or does not ship HEVC. An unknown codec name
 * deliberately falls through to `'no'`: transcoding a file that would have
 * played costs one cached conversion, while assuming support that is absent
 * leaves the user with the black screen this whole path exists to remove.
 */
export function probeNativePlayback(metadata: VideoMetadata): PlaybackSupport {
  const type = playbackMimeType(metadata);
  if (!type) return 'no';

  const probe = document.createElement('video');
  const answer = probe.canPlayType(type);
  if (answer === 'probably') return 'probably';
  if (answer === 'maybe') return 'maybe';
  return 'no';
}

/**
 * The `type; codecs="…"` string describing this file, or null when the
 * container or one of its codecs has no equivalent the engine understands.
 *
 * Kept separate from the probe itself so the mapping can be tested without a
 * browser, and so the answer to "can this play" always comes from the engine
 * rather than from a table maintained here.
 */
export function playbackMimeType(metadata: VideoMetadata): string | null {
  const container = CONTAINER_TYPES[extensionOf(metadata.fileName || metadata.path)];
  if (!container) return null;

  const video = VIDEO_CODEC_IDS[metadata.videoCodec.toLowerCase()];
  if (!video) return null;

  const codecs = [video];
  if (metadata.audio) {
    const audio = AUDIO_CODEC_IDS[metadata.audio.codec.toLowerCase()];
    if (!audio) return null;
    codecs.push(audio);
  }
  return `${container}; codecs="${codecs.join(', ')}"`;
}

/** Human-readable reason a file needs a proxy, for the preview banner. */
export function unsupportedReason(metadata: VideoMetadata): string {
  const extension = extensionOf(metadata.fileName || metadata.path);
  if (!CONTAINER_TYPES[extension]) {
    return `le conteneur .${extension || '?'} n’est pas lisible directement`;
  }
  if (!VIDEO_CODEC_IDS[metadata.videoCodec.toLowerCase()]) {
    return `le codec vidéo ${metadata.videoCodec.toUpperCase()} n’est pas lisible directement`;
  }
  const audioCodec = metadata.audio?.codec;
  if (audioCodec && !AUDIO_CODEC_IDS[audioCodec.toLowerCase()]) {
    return `le codec audio ${audioCodec.toUpperCase()} n’est pas lisible directement`;
  }
  return `le codec ${metadata.videoCodec.toUpperCase()} n’est pas lisible directement`;
}

/* ------------------------------------------------------------ geometry */

/**
 * Largest box of ratio `aspect` that fits inside `width` × `height`.
 *
 * The preview stage is sized from this rather than from CSS, because a stage
 * whose size depends on the video's intrinsic dimensions collapses to zero
 * while the file is still loading — and a zero-sized stage renders nothing at
 * all, including the caption overlay.
 */
export function containFit(
  width: number,
  height: number,
  aspect: number,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !(aspect > 0)) return { width: 0, height: 0 };
  const byWidth = { width, height: width / aspect };
  if (byWidth.height <= height) {
    return { width: Math.floor(byWidth.width), height: Math.floor(byWidth.height) };
  }
  return { width: Math.floor(height * aspect), height: Math.floor(height) };
}
