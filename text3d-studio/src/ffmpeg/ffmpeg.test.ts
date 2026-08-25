import { describe, expect, it } from 'vitest';
import landscape from './fixtures/landscape-h264-aac.json';
import verticalNoAudio from './fixtures/vertical-noaudio.json';
import {
  aspectRatioLabel,
  isVertical,
  parseFrameRate,
  parseProbeOutput,
  parseRotation,
  ProbeError,
} from './probe';
import {
  buildFilterGraph,
  describeFfmpegFailure,
  extractAudioArgs,
  normalizeDimensions,
  parseProgressTime,
  previewProxyArgs,
  probeArgs,
  QUALITY_PRESETS,
  renderArgs,
  thumbnailArgs,
} from './commands';

/** The fixtures are verbatim ffprobe output from real files built with ffmpeg. */
describe('parseProbeOutput', () => {
  it('reads a landscape H.264 + AAC file', () => {
    const meta = parseProbeOutput(JSON.stringify(landscape), '/tmp/a.mp4', 'a.mp4');
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
    expect(meta.fps).toBe(30);
    expect(meta.videoCodec).toBe('h264');
    expect(meta.durationSec).toBeGreaterThan(5.9);
    expect(meta.audio).not.toBeNull();
    expect(meta.audio?.codec).toBe('aac');
    expect(meta.audio?.sampleRate).toBe(48000);
    expect(meta.audio?.channels).toBe(2);
  });

  it('reads a vertical file that carries no audio', () => {
    const meta = parseProbeOutput(JSON.stringify(verticalNoAudio), '/tmp/b.mp4', 'b.mp4');
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
    expect(meta.audio).toBeNull();
    expect(isVertical(meta)).toBe(true);
  });

  it('rejects a file with no video stream, with a readable message', () => {
    const audioOnly = JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'mp3' }] });
    expect(() => parseProbeOutput(audioOnly, '/x', 'x')).toThrow(ProbeError);
    expect(() => parseProbeOutput(audioOnly, '/x', 'x')).toThrow(/aucune piste vidéo/i);
  });

  it('rejects output that is not JSON', () => {
    expect(() => parseProbeOutput('not json', '/x', 'x')).toThrow(ProbeError);
  });

  it('survives a probe missing duration, size and frame rate', () => {
    const sparse = JSON.stringify({ streams: [{ codec_type: 'video', width: 640, height: 480 }] });
    const meta = parseProbeOutput(sparse, '/x', 'x');
    expect(meta.durationSec).toBe(0);
    expect(meta.fps).toBe(0);
    expect(meta.videoCodec).toBe('inconnu');
  });

  it('swaps the dimensions of a file flagged as rotated', () => {
    const rotated = JSON.stringify({
      streams: [
        { codec_type: 'video', width: 1920, height: 1080, tags: { rotate: '90' } },
      ],
      format: { duration: '5' },
    });
    const meta = parseProbeOutput(rotated, '/x', 'x');
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
  });

  it('reads rotation from side data as well as tags', () => {
    expect(parseRotation({ side_data_list: [{ rotation: -90 }] })).toBe(90);
    expect(parseRotation({ tags: { rotate: '270' } })).toBe(270);
    expect(parseRotation({})).toBe(0);
  });
});

describe('parseFrameRate', () => {
  it('reduces the fractional form ffprobe reports', () => {
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('60/1')).toBe(60);
  });

  it('returns 0 for the degenerate values ffprobe emits on still images', () => {
    expect(parseFrameRate('0/0')).toBe(0);
    expect(parseFrameRate(undefined)).toBe(0);
    expect(parseFrameRate('garbage')).toBe(0);
  });
});

describe('aspect ratio', () => {
  it('reduces to the familiar labels', () => {
    expect(aspectRatioLabel(1920, 1080)).toBe('16:9');
    expect(aspectRatioLabel(1080, 1920)).toBe('9:16');
    expect(aspectRatioLabel(1080, 1080)).toBe('1:1');
    expect(aspectRatioLabel(1080, 1350)).toBe('4:5');
  });

  it('does not divide by zero', () => {
    expect(aspectRatioLabel(0, 0)).toBe('—');
  });
});

describe('command builders', () => {
  it('asks ffprobe for JSON with both format and streams', () => {
    const args = probeArgs('/v.mp4');
    expect(args).toContain('-print_format');
    expect(args).toContain('json');
    expect(args).toContain('-show_streams');
    expect(args[args.length - 1]).toBe('/v.mp4');
  });

  it('extracts audio as 16 kHz mono PCM, which is what Whisper expects', () => {
    const args = extractAudioArgs('/v.mp4', '/out.wav');
    expect(args).toContain('-vn');
    expect(args.join(' ')).toContain('-ar 16000');
    expect(args.join(' ')).toContain('-ac 1');
    expect(args.join(' ')).toContain('pcm_s16le');
  });

  it('seeks before the input when grabbing a thumbnail, for speed', () => {
    const args = thumbnailArgs('/v.mp4', '/t.jpg', 1.5);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('1.500');
  });

  it('maps the overlay over the source and keeps the original audio stream', () => {
    const args = renderArgs({
      inputPath: '/in.mp4',
      outputPath: '/out.mp4',
      format: { width: 1080, height: 1920, fps: 30 },
      fit: 'crop',
      encode: QUALITY_PRESETS.high!,
      hasAudio: true,
    });
    const line = args.join(' ');
    expect(line).toContain('-f image2pipe');
    expect(line).toContain('-i pipe:0');
    expect(line).toContain('-map [v]');
    expect(line).toContain('-map 0:a:0');
    expect(line).toContain('-c:a copy');
    expect(line).toContain('-pix_fmt yuv420p');
    expect(args[args.length - 1]).toBe('/out.mp4');
  });

  it('disables audio entirely when the source has none', () => {
    const args = renderArgs({
      inputPath: '/in.mp4',
      outputPath: '/out.mp4',
      format: { width: 1080, height: 1920, fps: 30 },
      fit: 'crop',
      encode: QUALITY_PRESETS.high!,
      hasAudio: false,
    });
    expect(args).toContain('-an');
    expect(args.join(' ')).not.toContain('-map 0:a');
  });

  it('re-encodes audio only when asked to', () => {
    const args = renderArgs({
      inputPath: '/in.mp4',
      outputPath: '/out.mp4',
      format: { width: 1080, height: 1920, fps: 30 },
      fit: 'crop',
      encode: QUALITY_PRESETS.small!,
      hasAudio: true,
    });
    expect(args.join(' ')).toContain('-c:a aac');
  });

  it('pins the output to the source duration, not to the overlay stream', () => {
    const args = renderArgs({
      inputPath: '/in.mp4',
      outputPath: '/out.mp4',
      format: { width: 1080, height: 1920, fps: 30 },
      fit: 'crop',
      encode: QUALITY_PRESETS.high!,
      hasAudio: true,
    });
    // Without this the longest input wins and a caption stream one frame too
    // long silently stretches the video.
    expect(args).toContain('-shortest');
  });

  it('uses an explicit duration instead of -shortest when one is given', () => {
    const args = renderArgs({
      inputPath: '/in.mp4',
      outputPath: '/out.mp4',
      format: { width: 1080, height: 1920, fps: 30 },
      fit: 'crop',
      encode: QUALITY_PRESETS.high!,
      hasAudio: true,
      durationSec: 3,
    });
    expect(args).toContain('-t');
    expect(args).toContain('3.000');
    expect(args).not.toContain('-shortest');
  });

  it('never emits a bare -vf alongside the filter_complex', () => {
    const args = renderArgs({
      inputPath: '/in.mp4',
      outputPath: '/out.mp4',
      format: { width: 1080, height: 1920, fps: 30 },
      fit: 'blur',
      encode: QUALITY_PRESETS.high!,
      hasAudio: true,
    });
    expect(args).not.toContain('-vf');
    expect(args).toContain('-filter_complex');
  });
});

describe('buildFilterGraph', () => {
  const format = { width: 1080, height: 1920, fps: 30 };

  it('always ends on the labelled overlay output', () => {
    for (const fit of ['crop', 'fit', 'blur', 'stretch'] as const) {
      const graph = buildFilterGraph(format, fit);
      expect(graph).toContain('[base][1:v]overlay=0:0');
      expect(graph.endsWith('[v]')).toBe(true);
    }
  });

  it('crops to fill for crop, and pads for fit', () => {
    expect(buildFilterGraph(format, 'crop')).toContain('force_original_aspect_ratio=increase');
    expect(buildFilterGraph(format, 'fit')).toContain('pad=1080:1920');
  });

  it('builds a blurred backdrop with the source centred over it', () => {
    const graph = buildFilterGraph(format, 'blur');
    expect(graph).toContain('split=2');
    expect(graph).toContain('gblur');
    expect(graph).toContain('overlay=(W-w)/2:(H-h)/2');
  });
});

describe('progress and errors', () => {
  it('reads the elapsed time out of an ffmpeg status line', () => {
    expect(parseProgressTime('frame=  120 fps=30 time=00:00:04.20 bitrate=N/A')).toBeCloseTo(4.2, 3);
    expect(parseProgressTime('time=01:02:03.5')).toBeCloseTo(3723.5, 3);
  });

  it('returns null for a line with no timing', () => {
    expect(parseProgressTime('Press [q] to stop')).toBeNull();
  });

  it('surfaces the meaningful ffmpeg error rather than the last noise line', () => {
    const stderr = [
      'ffmpeg version 6.1.1',
      '  built with gcc',
      "/nope.mp4: No such file or directory",
      '',
    ].join('\n');
    expect(describeFfmpegFailure(stderr)).toContain('No such file');
  });

  it('falls back to the last line when nothing matches', () => {
    expect(describeFfmpegFailure('weird\nfinal line')).toBe('final line');
    expect(describeFfmpegFailure('')).toMatch(/FFmpeg/);
  });
});

describe('normalizeDimensions', () => {
  it('rounds down to even numbers, as 4:2:0 requires', () => {
    expect(normalizeDimensions(1081, 1921)).toEqual({ width: 1080, height: 1920 });
    expect(normalizeDimensions(1080, 1920)).toEqual({ width: 1080, height: 1920 });
  });

  it('never returns a degenerate size', () => {
    expect(normalizeDimensions(0, 1)).toEqual({ width: 2, height: 2 });
  });
});

describe('previewProxyArgs', () => {
  it('re-encodes to what a browser engine can actually decode', () => {
    const args = previewProxyArgs('/in.mov', '/out.mp4');
    expect(args).toContain('libx264');
    expect(args).toContain('yuv420p');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.length - 1]).toBe('/out.mp4');
  });

  it('never enlarges a source that is already small', () => {
    const filter = previewProxyArgs('/in.mp4', '/out.mp4', 720)[
      previewProxyArgs('/in.mp4', '/out.mp4', 720).indexOf('-vf') + 1
    ];
    expect(filter).toContain('min(iw');
    expect(filter).toContain('720');
    // Odd dimensions would be rejected by yuv420p.
    expect(filter).toContain('force_divisible_by=2');
  });

  it('tolerates a source without audio', () => {
    // The trailing "?" is what keeps a silent clip from failing the mapping.
    expect(previewProxyArgs('/in.mp4', '/out.mp4')).toContain('0:a:0?');
  });

  it('puts the index first so playback can start before the file is read', () => {
    const args = previewProxyArgs('/in.mp4', '/out.mp4');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
  });

  it('reads the source and writes only the given output', () => {
    const args = previewProxyArgs('/in.mp4', '/out.mp4');
    expect(args.indexOf('/in.mp4')).toBe(args.indexOf('-i') + 1);
    expect(args.filter((arg) => arg === '/in.mp4')).toHaveLength(1);
  });
});
