import { describe, expect, it } from 'vitest';
import {
  deserializeVideoProject,
  serializeVideoProject,
  VideoProjectError,
  VIDEO_PROJECT_VERSION,
} from './project';
import type { VideoProjectSnapshot } from './store';
import { cloneCaptionStyle, DEFAULT_CAPTION_ANIMATION, DEFAULT_CAPTION_STYLE } from '@/captions/presets';
import { DEFAULT_SEGMENTATION } from '@/captions/segmentation';

const snapshot: VideoProjectSnapshot = {
  version: 1,
  videoPath: '/videos/demo.mp4',
  metadata: {
    path: '/videos/demo.mp4',
    fileName: 'demo.mp4',
    fileSize: 1234,
    durationSec: 12.5,
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: 'h264',
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
  },
  transcript: {
    language: 'fr',
    words: [{ id: 'w1', text: 'Bonjour', start: 0.2, end: 0.8 }],
    segments: [],
    source: { engine: 'whisper', model: 'base' },
  },
  track: {
    cues: [
      {
        id: 'c1',
        start: 0.2,
        end: 0.8,
        text: 'Bonjour',
        words: [{ id: 'w1', text: 'Bonjour', start: 0.2, end: 0.8 }],
      },
    ],
  },
  segmentation: { ...DEFAULT_SEGMENTATION },
  style: cloneCaptionStyle(DEFAULT_CAPTION_STYLE),
  animation: { ...DEFAULT_CAPTION_ANIMATION },
  presetId: 'viralPop',
  language: 'fr',
  tier: 'balanced',
  output: { width: 1080, height: 1920, fps: 30, fit: 'crop', quality: 'high' },
};

describe('video project round-trip', () => {
  it('restores the transcript, the cues and the style', () => {
    const restored = deserializeVideoProject(serializeVideoProject(snapshot));
    expect(restored.videoPath).toBe('/videos/demo.mp4');
    expect(restored.transcript?.words[0]?.text).toBe('Bonjour');
    expect(restored.track.cues[0]?.words[0]?.start).toBeCloseTo(0.2, 6);
    expect(restored.presetId).toBe('viralPop');
    expect(restored.output.height).toBe(1920);
  });

  it('keeps word-level timings intact, which is what synchronisation depends on', () => {
    const restored = deserializeVideoProject(serializeVideoProject(snapshot));
    expect(restored.track.cues[0]?.words).toEqual(snapshot.track.cues[0]?.words);
  });

  it('only references the video, never embeds it', () => {
    const json = serializeVideoProject(snapshot);
    expect(json).toContain('/videos/demo.mp4');
    // A project file stays small: no media, no base64 payload.
    expect(json.length).toBeLessThan(20000);
  });

  it('rejects a file that is not JSON', () => {
    expect(() => deserializeVideoProject('nope')).toThrow(VideoProjectError);
  });

  it('rejects a project without a version', () => {
    expect(() => deserializeVideoProject('{"videoPath":"/a.mp4"}')).toThrow(/version/i);
  });

  it('rejects a project from a newer version', () => {
    expect(() =>
      deserializeVideoProject(JSON.stringify({ version: VIDEO_PROJECT_VERSION + 3 })),
    ).toThrow(/plus récente/);
  });

  it('fills in the defaults for a minimal file instead of failing', () => {
    const restored = deserializeVideoProject(JSON.stringify({ version: 1 }));
    expect(restored.track.cues).toEqual([]);
    expect(restored.output.fps).toBe(30);
    expect(restored.segmentation.maxCharacters).toBe(DEFAULT_SEGMENTATION.maxCharacters);
  });
});
