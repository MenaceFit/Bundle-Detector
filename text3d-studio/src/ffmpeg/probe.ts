import type { AudioMetadata, VideoMetadata } from '@/captions/types';

/**
 * Turns ffprobe's JSON into the metadata the app works with.
 *
 * Written defensively: ffprobe omits fields depending on the container, reports
 * frame rates as fractions, and sometimes carries the duration only on the
 * format object. A file we cannot fully describe should still import.
 */

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string; format_name?: string };
}

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

/** `30000/1001` → 29.97. Returns 0 for the `0/0` ffprobe emits on still images. */
export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split('/').map(Number);
  if (!Number.isFinite(num as number)) return 0;
  if (den === undefined || den === 0) return Number.isFinite(num as number) ? (num as number) : 0;
  const fps = (num as number) / den;
  return Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : 0;
}

/**
 * Rotation recorded in the container. Phone footage is very often stored
 * landscape with a 90° flag, and ignoring it would give a sideways preview and
 * the wrong aspect ratio for the vertical conversion.
 */
export function parseRotation(stream: ProbeStream): number {
  const fromTag = Number(stream.tags?.['rotate'] ?? NaN);
  if (Number.isFinite(fromTag)) return ((fromTag % 360) + 360) % 360;

  const fromSideData = stream.side_data_list?.find((entry) => entry.rotation !== undefined);
  if (fromSideData?.rotation !== undefined) {
    // Side data reports the rotation to *undo*, hence the negation.
    return ((-fromSideData.rotation % 360) + 360) % 360;
  }
  return 0;
}

export function parseProbeOutput(
  json: string,
  filePath: string,
  fileName: string,
): VideoMetadata {
  let parsed: ProbeResult;
  try {
    parsed = JSON.parse(json) as ProbeResult;
  } catch {
    throw new ProbeError("ffprobe n'a pas renvoyé de JSON exploitable.");
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) {
    throw new ProbeError('Ce fichier ne contient aucune piste vidéo.');
  }

  const audioStream = streams.find((stream) => stream.codec_type === 'audio');
  const audio: AudioMetadata | null = audioStream
    ? {
        codec: audioStream.codec_name ?? 'inconnu',
        sampleRate: Number(audioStream.sample_rate ?? 0) || 0,
        channels: audioStream.channels ?? 0,
        channelLayout: audioStream.channel_layout ?? (audioStream.channels === 1 ? 'mono' : 'stereo'),
      }
    : null;

  const rotation = parseRotation(video);
  const rawWidth = video.width ?? 0;
  const rawHeight = video.height ?? 0;
  const swapped = rotation === 90 || rotation === 270;

  const duration =
    Number(parsed.format?.duration ?? NaN) ||
    Number(video.duration ?? NaN) ||
    0;

  return {
    path: filePath,
    fileName,
    fileSize: Number(parsed.format?.size ?? 0) || 0,
    durationSec: Number.isFinite(duration) ? duration : 0,
    width: swapped ? rawHeight : rawWidth,
    height: swapped ? rawWidth : rawHeight,
    fps: parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate),
    videoCodec: video.codec_name ?? 'inconnu',
    audio,
  };
}

/** `9:16`, `16:9`… reduced with the greatest common divisor. */
export function aspectRatioLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '—';
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

export function isVertical(metadata: VideoMetadata): boolean {
  return metadata.height > metadata.width;
}
