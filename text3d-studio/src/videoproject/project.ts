import type { VideoProjectSnapshot } from './store';
import { DEFAULT_SEGMENTATION } from '@/captions/segmentation';
import { cloneCaptionStyle, DEFAULT_CAPTION_ANIMATION, DEFAULT_CAPTION_STYLE } from '@/captions/presets';

/**
 * `.video-project.json` — the captions project format.
 *
 * It holds only the *description* of the work: the path of the source video,
 * the transcript, the caption track, the style and the export settings. The
 * video itself is never copied or modified, so a project file stays tiny and
 * the original footage is always untouched.
 */

export const VIDEO_PROJECT_VERSION = 1;

export class VideoProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoProjectError';
  }
}

export function serializeVideoProject(snapshot: VideoProjectSnapshot): string {
  return JSON.stringify({ ...snapshot, version: VIDEO_PROJECT_VERSION }, null, 2);
}

/**
 * Parses a project file, filling in anything missing from the defaults so a
 * file written by an earlier build still opens.
 */
export function deserializeVideoProject(content: string): VideoProjectSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new VideoProjectError('Fichier illisible : ce n’est pas du JSON valide.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new VideoProjectError('Fichier de projet vidéo invalide.');
  }

  const data = raw as Partial<VideoProjectSnapshot> & { version?: number };
  if (typeof data.version !== 'number') {
    throw new VideoProjectError('Fichier de projet vidéo invalide : version manquante.');
  }
  if (data.version > VIDEO_PROJECT_VERSION) {
    throw new VideoProjectError(
      `Ce projet a été créé avec une version plus récente (v${data.version}).`,
    );
  }

  return {
    version: VIDEO_PROJECT_VERSION,
    videoPath: typeof data.videoPath === 'string' ? data.videoPath : null,
    metadata: data.metadata ?? null,
    transcript: data.transcript ?? null,
    track: data.track ?? { cues: [] },
    segmentation: { ...DEFAULT_SEGMENTATION, ...(data.segmentation ?? {}) },
    style: data.style
      ? { ...cloneCaptionStyle(DEFAULT_CAPTION_STYLE), ...data.style }
      : cloneCaptionStyle(DEFAULT_CAPTION_STYLE),
    animation: { ...DEFAULT_CAPTION_ANIMATION, ...(data.animation ?? {}) },
    presetId: typeof data.presetId === 'string' ? data.presetId : 'classic',
    language: typeof data.language === 'string' ? data.language : 'auto',
    tier: data.tier ?? 'balanced',
    output: {
      width: data.output?.width ?? 1080,
      height: data.output?.height ?? 1920,
      fps: data.output?.fps ?? 30,
      fit: data.output?.fit ?? 'crop',
      quality: data.output?.quality ?? 'high',
    },
  };
}
