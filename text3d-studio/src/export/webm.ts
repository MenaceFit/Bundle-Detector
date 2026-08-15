import { createLogger } from '@/utils/logger';

const log = createLogger('export:webm');

/**
 * Codec candidates, best first. VP9 and VP8 in WebM carry an alpha channel in
 * Chromium, which is what keeps the export transparent; the last entries are
 * fallbacks that will lose alpha but still produce a playable file.
 */
const CODECS = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickWebmMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return CODECS.find((codec) => MediaRecorder.isTypeSupported(codec)) ?? null;
}

export function supportsTransparentWebm(mimeType: string): boolean {
  return mimeType.includes('vp9') || mimeType.includes('vp8');
}

export interface WebmOptions {
  fps: number;
  /** Target bitrate in bits per second. */
  bitrate: number;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/**
 * Records `frameCount` frames from a canvas into a WebM blob.
 *
 * Frames are pushed explicitly through `requestFrame()` rather than letting the
 * recorder sample in real time, so a heavy composition still produces exactly
 * the right number of frames at the requested rate.
 */
export async function recordWebm(
  canvas: HTMLCanvasElement,
  frameCount: number,
  drawFrame: (index: number) => void,
  options: WebmOptions,
): Promise<Blob> {
  const mimeType = pickWebmMimeType();
  if (!mimeType) {
    throw new Error("L'export WebM n'est pas supporté par cet environnement.");
  }

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as (CanvasCaptureMediaStreamTrack | undefined);
  if (!track) {
    throw new Error("Impossible de capturer le canvas pour l'export vidéo.");
  }

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: options.bitrate,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = () => reject(new Error("Erreur pendant l'enregistrement WebM."));
  });

  recorder.start();

  const frameDelay = 1000 / options.fps;
  try {
    for (let i = 0; i < frameCount; i += 1) {
      if (options.signal?.aborted) throw new Error('Export annulé.');
      drawFrame(i);
      track.requestFrame();
      options.onProgress?.((i + 1) / frameCount);
      // Yield long enough for the encoder to pick the frame up.
      await delay(Math.max(8, frameDelay));
    }
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
  }

  const blob = await finished;
  log.info('WebM encodé', { mimeType, frames: frameCount, size: blob.size });
  return blob;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
