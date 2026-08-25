import type { CaptionAnimation, CaptionStyle, CaptionTrack, VideoMetadata } from '@/captions/types';
import { renderCaptionFrame } from '@/captions/renderer';
import { createCanvas } from '@/engine/renderer/scratch';
import { clearPool } from '@/engine/renderer/scratch';
import {
  describeFfmpegFailure,
  extractAudioArgs,
  normalizeDimensions,
  parseProbeOutput,
  parseProgressTime,
  previewProxyArgs,
  probeArgs,
  renderArgs,
  thumbnailArgs,
  type EncodeSettings,
  type FitMode,
} from '@/ffmpeg';
import { generateId } from '@/utils/object';
import { clamp } from '@/utils/math';
import { createLogger } from '@/utils/logger';

const log = createLogger('video-pipeline');

/**
 * Orchestrates the media side of the captions workspace.
 *
 * Every ffmpeg invocation happens in the main process; this module only decides
 * *what* to run and streams caption frames into it. The source video is opened
 * read-only and never rewritten — extracted audio, thumbnails and waveforms all
 * land in a cache directory keyed to the file.
 */

function bridge() {
  const desktop = window.desktop;
  if (!desktop?.video || !desktop.render || !desktop.ffmpeg) {
    throw new Error(
      "L'atelier vidéo nécessite l'application de bureau : le navigateur ne peut pas piloter FFmpeg.",
    );
  }
  return { video: desktop.video, render: desktop.render, ffmpeg: desktop.ffmpeg };
}

export function isDesktopVideoAvailable(): boolean {
  const desktop = window.desktop;
  return Boolean(desktop?.video && desktop.render && desktop.ffmpeg);
}

export async function ffmpegStatus() {
  return bridge().ffmpeg.status();
}

export async function pickVideo(): Promise<{ path: string; name: string } | null> {
  return bridge().video.pick();
}

export async function probeVideo(filePath: string, fileName: string): Promise<VideoMetadata> {
  const json = await bridge().video.probe({ path: filePath, args: probeArgs(filePath) });
  return parseProbeOutput(json, filePath, fileName);
}

const OUTPUT_PLACEHOLDER = '__OUTPUT__';

/** Extracts (or reuses) the 16 kHz mono WAV the transcription engine needs. */
export async function extractAudio(metadata: VideoMetadata): Promise<string> {
  const { path } = await bridge().video.derive({
    sourcePath: metadata.path,
    outputName: 'audio-16k-mono.wav',
    buildArgs: extractAudioArgs(metadata.path, OUTPUT_PLACEHOLDER),
    placeholder: OUTPUT_PLACEHOLDER,
  });
  return path;
}

/**
 * Builds (or reuses) the H.264 proxy used when the source cannot be played
 * natively. Returns the path of a file inside the per-video cache directory —
 * the original is never touched.
 */
export async function buildPreviewProxy(metadata: VideoMetadata): Promise<string> {
  const { path } = await bridge().video.derive({
    sourcePath: metadata.path,
    outputName: 'preview-proxy.mp4',
    buildArgs: previewProxyArgs(metadata.path, OUTPUT_PLACEHOLDER),
    placeholder: OUTPUT_PLACEHOLDER,
  });
  return path;
}

export async function generateThumbnail(metadata: VideoMetadata): Promise<string> {
  const at = clamp(metadata.durationSec * 0.1, 0, Math.max(0, metadata.durationSec - 0.1));
  const { path } = await bridge().video.derive({
    sourcePath: metadata.path,
    outputName: 'thumbnail.jpg',
    buildArgs: thumbnailArgs(metadata.path, OUTPUT_PLACEHOLDER, at, 480),
    placeholder: OUTPUT_PLACEHOLDER,
  });
  const bytes = await bridge().video.readFile(path);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}

/** Decodes the extracted WAV into the mono float samples Whisper consumes. */
export async function loadAudioSamples(wavPath: string): Promise<Float32Array> {
  const buffer = await bridge().video.readFile(wavPath);
  const context = new OfflineAudioContext(1, 1, 16000);
  const decoded = await context.decodeAudioData(buffer.slice(0));
  return decoded.getChannelData(0);
}

export async function loadWaveform(wavPath: string, buckets = 1200): Promise<number[]> {
  return bridge().video.waveform({ wavPath, buckets });
}

/* ---------------------------------------------------------------- export */

export interface VideoExportOptions {
  metadata: VideoMetadata;
  track: CaptionTrack;
  style: CaptionStyle;
  animation: CaptionAnimation;
  width: number;
  height: number;
  fps: number;
  fit: FitMode;
  encode: EncodeSettings;
  outputPath: string;
  onProgress?: (ratio: number, label: string) => void;
  signal?: AbortSignal;
}

export interface VideoExportResult {
  outputPath: string;
  frames: number;
}

/**
 * Burns the captions into a new MP4.
 *
 * Caption frames are rendered here, at full output resolution, and pushed to
 * ffmpeg as a PNG stream. Two progress sources are combined: the frames we have
 * produced, and the timestamps ffmpeg reports back while encoding.
 */
export async function exportVideoWithCaptions(
  options: VideoExportOptions,
): Promise<VideoExportResult> {
  const { render } = bridge();
  const { width, height } = normalizeDimensions(options.width, options.height);
  const duration = options.metadata.durationSec;
  const frameCount = Math.max(1, Math.round(duration * options.fps));
  const jobId = generateId('render');

  const args = renderArgs({
    inputPath: options.metadata.path,
    outputPath: options.outputPath,
    format: { width, height, fps: options.fps },
    fit: options.fit,
    encode: options.encode,
    hasAudio: options.metadata.audio !== null,
  });

  let stderr = '';
  const stopProgress = render.onProgress((payload) => {
    if (payload.id !== jobId) return;
    stderr = `${stderr}${payload.chunk}`.slice(-8000);
    const seconds = parseProgressTime(payload.chunk);
    if (seconds !== null && duration > 0) {
      options.onProgress?.(clamp(seconds / duration, 0, 1), 'Encodage');
    }
  });

  const surface = createCanvas(width, height);

  try {
    await render.start({ id: jobId, args, totalSec: duration });

    for (let index = 0; index < frameCount; index += 1) {
      if (options.signal?.aborted) {
        await render.cancel(jobId);
        throw new Error('Export annulé.');
      }

      const time = index / options.fps;
      renderCaptionFrame(
        surface.ctx,
        {
          track: options.track,
          style: options.style,
          animation: options.animation,
          width,
          height,
          time,
        },
        'final',
      );

      const blob = await canvasToPng(surface.canvas);
      const accepted = await render.frame({ id: jobId, data: await blob.arrayBuffer() });
      // ffmpeg closes the pipe once it has every frame it needs; that is a
      // normal end of stream, not an error.
      if (!accepted) break;

      options.onProgress?.(clamp((index + 1) / frameCount, 0, 0.99), 'Rendu des sous-titres');
    }

    const result = await render.finish(jobId);
    if (!result.ok) {
      throw new Error(describeFfmpegFailure(result.stderr || stderr));
    }

    options.onProgress?.(1, 'Terminé');
    log.info('Export terminé', { output: options.outputPath, frames: frameCount });
    return { outputPath: options.outputPath, frames: frameCount };
  } finally {
    stopProgress();
    surface.canvas.width = 0;
    surface.canvas.height = 0;
    clearPool();
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Le rendu d'une image de sous-titre a échoué."));
    }, 'image/png');
  });
}

export async function pickOutputPath(suggested: string): Promise<string | null> {
  const result = await bridge().video.pickOutput(suggested);
  return result?.path ?? null;
}
