/**
 * FFmpeg argument builders.
 *
 * Kept pure and free of Node so they can be unit-tested, and so the renderer
 * and the main process agree on exactly one definition of every pipeline.
 */

export type FitMode = 'crop' | 'fit' | 'blur' | 'stretch';

export interface OutputFormat {
  width: number;
  height: number;
  fps: number;
}

export interface EncodeSettings {
  /** Constant Rate Factor: lower is better quality, 18–28 is the useful band. */
  crf: number;
  preset: 'ultrafast' | 'veryfast' | 'fast' | 'medium' | 'slow';
  /** Copy the source audio stream untouched whenever the container allows it. */
  copyAudio: boolean;
  audioBitrateKbps: number;
}

export const QUALITY_PRESETS: Record<string, EncodeSettings> = {
  social: { crf: 23, preset: 'veryfast', copyAudio: true, audioBitrateKbps: 128 },
  high: { crf: 20, preset: 'medium', copyAudio: true, audioBitrateKbps: 192 },
  maximum: { crf: 16, preset: 'slow', copyAudio: true, audioBitrateKbps: 256 },
  small: { crf: 28, preset: 'veryfast', copyAudio: false, audioBitrateKbps: 96 },
};

export function probeArgs(inputPath: string): string[] {
  return [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ];
}

/**
 * Extracts audio as 16 kHz mono PCM — the input every Whisper implementation
 * expects, so no resampling is needed downstream.
 */
export function extractAudioArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-i', inputPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outputPath,
  ];
}

/** Single frame at `timeSec`, used for the import thumbnail. */
export function thumbnailArgs(
  inputPath: string,
  outputPath: string,
  timeSec: number,
  width = 320,
): string[] {
  return [
    '-y',
    // Seeking before -i is the fast path: it jumps rather than decoding.
    '-ss', timeSec.toFixed(3),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    outputPath,
  ];
}

/**
 * Builds the video filter chain that maps the source frame into the output
 * format, then lays the caption overlay on top.
 *
 * `blur` is the vertical-conversion look: the source is enlarged and blurred to
 * fill the frame, with the untouched source centred over it.
 */
export function buildFilterGraph(format: OutputFormat, fit: FitMode): string {
  const { width: w, height: h } = format;
  const fitted = (() => {
    switch (fit) {
      case 'stretch':
        return `[0:v]scale=${w}:${h},setsar=1[base]`;
      case 'fit':
        return (
          `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[base]`
        );
      case 'blur':
        return (
          `[0:v]split=2[bgsrc][fgsrc];` +
          `[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,` +
          `crop=${w}:${h},gblur=sigma=28,eq=brightness=-0.12[bg];` +
          `[fgsrc]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];` +
          `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`
        );
      case 'crop':
      default:
        return (
          `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,` +
          `crop=${w}:${h},setsar=1[base]`
        );
    }
  })();

  return `${fitted};[base][1:v]overlay=0:0:format=auto,fps=${format.fps}[v]`;
}

export interface RenderOptions {
  inputPath: string;
  outputPath: string;
  format: OutputFormat;
  fit: FitMode;
  encode: EncodeSettings;
  /** False when the source has no audio stream at all. */
  hasAudio: boolean;
  /** Limit the render to the first N seconds; used by the preview render. */
  durationSec?: number;
}

/**
 * Burns the caption overlay into the video.
 *
 * The overlay arrives on stdin as a PNG stream rather than as files: PNG keeps
 * the alpha channel exactly, compresses the mostly-empty caption frames to a
 * fraction of raw RGBA, and avoids writing a thousand temporary images.
 */
export function renderArgs(options: RenderOptions): string[] {
  const { format, encode } = options;
  const args = [
    '-y',
    '-i', options.inputPath,
    '-f', 'image2pipe',
    '-framerate', String(format.fps),
    '-i', 'pipe:0',
    '-filter_complex', buildFilterGraph(format, options.fit),
    '-map', '[v]',
  ];

  if (options.hasAudio) {
    args.push('-map', '0:a:0');
    if (encode.copyAudio) {
      // Preserve the original stream; nothing is re-encoded, nothing is lost.
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', `${encode.audioBitrateKbps}k`);
    }
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', encode.preset,
    '-crf', String(encode.crf),
    // 4:2:0 8-bit is what every player and every social platform accepts.
    // (No -vf here: the scaling lives in the filter_complex that produced [v].)
    '-pix_fmt', 'yuv420p',
  );

  if (options.durationSec !== undefined) {
    args.push('-t', options.durationSec.toFixed(3));
  } else {
    // The output length follows the *longest* input, so an overlay stream that
    // runs even one frame past the video would stretch the result. Ending on
    // the shortest input pins the output to the source video's duration.
    args.push('-shortest');
  }

  args.push('-movflags', '+faststart', options.outputPath);
  return args;
}

/** Even dimensions, required by the 4:2:0 pixel format. */
export function normalizeDimensions(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(2, Math.floor(width / 2) * 2),
    height: Math.max(2, Math.floor(height / 2) * 2),
  };
}

/**
 * Parses the `-progress`-style and stderr output of a running ffmpeg.
 *
 * ffmpeg reports progress on stderr as `time=00:00:04.20`; converting that to a
 * ratio needs the known total duration.
 */
export function parseProgressTime(line: string): number | null {
  const match = /time=(\d+):(\d{2}):(\d{2})\.(\d{1,3})/.exec(line);
  if (!match) return null;
  const [, h, m, s, frac] = match;
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number((frac ?? '0').padEnd(3, '0')) / 1000
  );
}

/** Extracts a human-readable reason from ffmpeg's stderr tail. */
export function describeFfmpegFailure(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const known = lines.find((line) =>
    /No such file|Invalid data|Permission denied|Unknown encoder|does not contain|Conversion failed|Invalid argument/i.test(
      line,
    ),
  );
  return known ?? lines[lines.length - 1] ?? 'FFmpeg a échoué sans message.';
}
