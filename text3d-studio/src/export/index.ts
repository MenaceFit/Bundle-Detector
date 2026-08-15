import type { ExportQuality, ExportSettings, Project } from '@/types';
import { createFrameRenderer, frameTimes } from './frame';
import { GifEncoder } from './gif/encoder';
import { ColorCollector } from './gif/quantize';
import { recordWebm, pickWebmMimeType, supportsTransparentWebm } from './webm';
import { createZip } from './zip';
import { saveBlob, saveFrames, toArrayBuffer, type SaveResult } from './save';
import { clearPool } from '@/engine/renderer/scratch';
import { sanitizeFileName } from '@/utils/format';
import { createLogger } from '@/utils/logger';

const log = createLogger('export');

export interface ExportProgress {
  phase: string;
  ratio: number;
}

export interface ExportCallbacks {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}

/** Largest frame we will attempt, to keep the browser from dying on OOM. */
const MAX_PIXELS = 8192 * 8192;

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

function imageQuality(quality: ExportQuality): number {
  switch (quality) {
    case 'low':
      return 0.6;
    case 'medium':
      return 0.8;
    case 'high':
      return 0.92;
    case 'max':
      return 1;
    default:
      return 0.92;
  }
}

function videoBitrate(width: number, height: number, fps: number, quality: ExportQuality): number {
  const factor = { low: 0.05, medium: 0.1, high: 0.18, max: 0.3 }[quality] ?? 0.18;
  return Math.round(Math.min(60_000_000, Math.max(1_000_000, width * height * fps * factor)));
}

function validate(settings: ExportSettings): void {
  if (!Number.isFinite(settings.width) || !Number.isFinite(settings.height)) {
    throw new ExportError('Résolution invalide.');
  }
  if (settings.width < 1 || settings.height < 1) {
    throw new ExportError('La résolution doit être supérieure à zéro.');
  }
  if (settings.width * settings.height > MAX_PIXELS) {
    throw new ExportError(
      'Résolution trop importante : réduisez la taille (limite 8192 × 8192).',
    );
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new ExportError("Le rendu de l'image a échoué (mémoire insuffisante ?)."));
      },
      type,
      quality,
    );
  });
}

/** Runs the export described by `settings` and writes the result to disk. */
export async function runExport(
  project: Project,
  settings: ExportSettings,
  time: number,
  callbacks: ExportCallbacks = {},
): Promise<SaveResult | null> {
  validate(settings);

  const background = settings.transparent ? null : settings.backgroundColor;
  const baseName = sanitizeFileName(project.name);

  try {
    switch (settings.format) {
      case 'png':
      case 'webp':
        return await exportImage(project, settings, time, background, baseName);
      case 'webm':
        return await exportWebm(project, settings, background, baseName, callbacks);
      case 'gif':
        return await exportGif(project, settings, background, baseName, callbacks);
      case 'sequence':
        return await exportSequence(project, settings, background, baseName, callbacks);
      default:
        throw new ExportError('Format d’export inconnu.');
    }
  } finally {
    // Export buffers are huge; do not keep them pooled for the preview.
    clearPool();
  }
}

async function exportImage(
  project: Project,
  settings: ExportSettings,
  time: number,
  background: string | null,
  baseName: string,
): Promise<SaveResult | null> {
  const renderer = createFrameRenderer(project, {
    width: settings.width,
    height: settings.height,
    background,
  });

  try {
    renderer.draw(time);
    const mime = settings.format === 'webp' ? 'image/webp' : 'image/png';
    const blob = await canvasToBlob(
      renderer.canvas,
      mime,
      settings.format === 'webp' ? imageQuality(settings.quality) : undefined,
    );
    log.info('Image exportée', { format: settings.format, size: blob.size });
    return saveBlob(blob, `${baseName}.${settings.format}`, [settings.format]);
  } finally {
    renderer.dispose();
  }
}

async function exportWebm(
  project: Project,
  settings: ExportSettings,
  background: string | null,
  baseName: string,
  callbacks: ExportCallbacks,
): Promise<SaveResult | null> {
  const mimeType = pickWebmMimeType();
  if (!mimeType) throw new ExportError("L'export WebM n'est pas supporté ici.");
  if (settings.transparent && !supportsTransparentWebm(mimeType)) {
    log.warn('Le codec disponible ne préserve pas la transparence', { mimeType });
  }

  const duration = settings.duration ?? project.timeline.duration;
  const times = frameTimes(duration, settings.fps);
  const renderer = createFrameRenderer(project, {
    width: settings.width,
    height: settings.height,
    background,
  });

  try {
    const blob = await recordWebm(
      renderer.canvas,
      times.length,
      (index) => renderer.draw(times[index] ?? 0),
      {
        fps: settings.fps,
        bitrate: videoBitrate(settings.width, settings.height, settings.fps, settings.quality),
        onProgress: (ratio) => callbacks.onProgress?.({ phase: 'Encodage vidéo', ratio }),
        ...(callbacks.signal ? { signal: callbacks.signal } : {}),
      },
    );
    return saveBlob(blob, `${baseName}.webm`, ['webm']);
  } finally {
    renderer.dispose();
  }
}

async function exportGif(
  project: Project,
  settings: ExportSettings,
  background: string | null,
  baseName: string,
  callbacks: ExportCallbacks,
): Promise<SaveResult | null> {
  const duration = settings.duration ?? project.timeline.duration;
  // GIF tops out at 50 fps and gets very heavy past 25; cap for sanity.
  const fps = Math.min(50, settings.fps);
  const times = frameTimes(duration, fps);
  const renderer = createFrameRenderer(project, {
    width: settings.width,
    height: settings.height,
    background,
  });

  try {
    // Pass 1 — sample frames to build a shared palette.
    const collector = new ColorCollector();
    const sampleStep = Math.max(1, Math.floor(times.length / 12));
    for (let i = 0; i < times.length; i += sampleStep) {
      if (callbacks.signal?.aborted) throw new ExportError('Export annulé.');
      renderer.draw(times[i] ?? 0);
      const data = renderer.ctx.getImageData(0, 0, settings.width, settings.height);
      collector.add(data.data);
      callbacks.onProgress?.({ phase: 'Analyse des couleurs', ratio: i / times.length });
      await yieldToUi();
    }

    const palette = collector.build(Math.min(255, Math.max(2, settings.gifColors)));

    // Pass 2 — encode.
    const encoder = new GifEncoder(settings.width, settings.height, palette, {
      loop: settings.loop,
    });
    const delayMs = 1000 / fps;

    for (let i = 0; i < times.length; i += 1) {
      if (callbacks.signal?.aborted) throw new ExportError('Export annulé.');
      renderer.draw(times[i] ?? 0);
      const data = renderer.ctx.getImageData(0, 0, settings.width, settings.height);
      encoder.addFrame(data.data, delayMs);
      callbacks.onProgress?.({ phase: 'Encodage GIF', ratio: (i + 1) / times.length });
      await yieldToUi();
    }

    const bytes = encoder.finish();
    const blob = new Blob([toArrayBuffer(bytes)], { type: 'image/gif' });
    log.info('GIF encodé', { frames: times.length, colors: palette.size, size: blob.size });
    return saveBlob(blob, `${baseName}.gif`, ['gif']);
  } finally {
    renderer.dispose();
  }
}

async function exportSequence(
  project: Project,
  settings: ExportSettings,
  background: string | null,
  baseName: string,
  callbacks: ExportCallbacks,
): Promise<SaveResult | null> {
  const duration = settings.duration ?? project.timeline.duration;
  const times = frameTimes(duration, settings.fps);
  const renderer = createFrameRenderer(project, {
    width: settings.width,
    height: settings.height,
    background,
  });

  try {
    const frames: Array<{ name: string; data: Uint8Array }> = [];
    const pad = String(times.length).length;

    for (let i = 0; i < times.length; i += 1) {
      if (callbacks.signal?.aborted) throw new ExportError('Export annulé.');
      renderer.draw(times[i] ?? 0);
      const blob = await canvasToBlob(renderer.canvas, 'image/png');
      frames.push({
        name: `${baseName}_${String(i).padStart(pad, '0')}.png`,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
      callbacks.onProgress?.({ phase: 'Rendu des images', ratio: (i + 1) / times.length });
      await yieldToUi();
    }

    return saveFrames(frames, `${baseName}_sequence`, () =>
      new Blob([toArrayBuffer(createZip(frames))], { type: 'application/zip' }),
    );
  } finally {
    renderer.dispose();
  }
}

/** Estimated output size in bytes — deliberately rough, shown as an order of magnitude. */
export function estimateSize(project: Project, settings: ExportSettings): number {
  const pixels = settings.width * settings.height;
  const duration = settings.duration ?? project.timeline.duration;

  switch (settings.format) {
    case 'png':
      // Flat art with large uniform areas compresses hard.
      return Math.round(pixels * 0.55);
    case 'webp':
      return Math.round(pixels * 0.25 * imageQuality(settings.quality));
    case 'webm':
      return Math.round(
        (videoBitrate(settings.width, settings.height, settings.fps, settings.quality) * duration) / 8,
      );
    case 'gif': {
      const frames = Math.max(1, Math.round(duration * Math.min(50, settings.fps)));
      return Math.round(pixels * frames * 0.12);
    }
    case 'sequence': {
      const frames = Math.max(1, Math.round(duration * settings.fps));
      return Math.round(pixels * 0.55 * frames);
    }
    default:
      return 0;
  }
}

/** Hands control back to the browser so the progress bar can repaint. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
