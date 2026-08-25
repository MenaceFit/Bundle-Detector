import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VideoMetadata } from '@/captions/types';
import { containFit, mediaUrl, playbackMimeType, unsupportedReason } from './playback';
import { decodeMediaPath, isStreamablePath, mediaMimeType, parseRange } from '../../electron/mediaPath';
import { mediaResponse } from '../../electron/mediaStream';

function meta(patch: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    path: '/videos/clip.mp4',
    fileName: 'clip.mp4',
    fileSize: 1024,
    durationSec: 10,
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: 'h264',
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
    ...patch,
  };
}

describe('mediaUrl / decodeMediaPath round trip', () => {
  const cases: Array<[string, string]> = [
    ['/home/user/Vidéos/clip.mp4', '/home/user/Vidéos/clip.mp4'],
    ['/home/user/a b/c#1?x.mp4', '/home/user/a b/c#1?x.mp4'],
    ['/home/user/100% final.mp4', '/home/user/100% final.mp4'],
    // Windows: the drive letter must survive, and the URL's leading slash must not.
    ['C:\\Users\\Nael\\Videos\\0818_noisles.mp4', 'C:/Users/Nael/Videos/0818_noisles.mp4'],
    ['C:/Users/Nael/Mes Vidéos/été #2.mp4', 'C:/Users/Nael/Mes Vidéos/été #2.mp4'],
  ];

  for (const [input, expected] of cases) {
    it(`survives ${input}`, () => {
      const url = new URL(mediaUrl(input));
      expect(url.protocol).toBe('appmedia:');
      expect(decodeMediaPath(url.pathname)).toBe(expected);
    });
  }

  it('keeps a UNC share double slash', () => {
    const url = new URL(mediaUrl('\\\\nas\\media\\clip.mp4'));
    expect(url.pathname.startsWith('//')).toBe(true);
  });

  it('encodes every segment separately', () => {
    // A bare `#` would otherwise start the URL fragment and truncate the path.
    expect(mediaUrl('/a/b#c.mp4')).toBe('appmedia://local/a/b%23c.mp4');
  });
});

describe('isStreamablePath', () => {
  it('accepts absolute POSIX and Windows paths', () => {
    expect(isStreamablePath('/home/user/a.mp4')).toBe(true);
    expect(isStreamablePath('C:/Users/a.mp4')).toBe(true);
    expect(isStreamablePath('C:\\Users\\a.mp4')).toBe(true);
  });

  it('rejects relative paths, empties and NUL injection', () => {
    expect(isStreamablePath('relative/a.mp4')).toBe(false);
    expect(isStreamablePath('')).toBe(false);
    expect(isStreamablePath('/home/a\0.mp4')).toBe(false);
  });
});

describe('mediaMimeType', () => {
  it('maps the containers the player receives', () => {
    expect(mediaMimeType('/x/a.mp4')).toBe('video/mp4');
    expect(mediaMimeType('/x/a.MOV')).toBe('video/mp4');
    expect(mediaMimeType('/x/a.webm')).toBe('video/webm');
    expect(mediaMimeType('/x/a.bin')).toBe('application/octet-stream');
  });
});

describe('parseRange', () => {
  it('reads an open-ended range', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('reads a closed range and clamps it to the file', () => {
    expect(parseRange('bytes=10-20', 1000)).toEqual({ start: 10, end: 20 });
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 });
  });

  it('reads a suffix range', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('returns null for what should be answered with the whole file', () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('bytes=1000-', 1000)).toBeNull();
    expect(parseRange('bytes=20-10', 1000)).toBeNull();
    expect(parseRange('items=0-10', 1000)).toBeNull();
  });
});

describe('playbackMimeType', () => {
  it('describes a plain H.264 + AAC MP4', () => {
    expect(playbackMimeType(meta())).toBe('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
  });

  it('describes a silent source without an audio codec', () => {
    expect(playbackMimeType(meta({ audio: null }))).toBe('video/mp4; codecs="avc1.42E01E"');
  });

  it('still describes HEVC — whether it plays is the engine\u2019s answer, not ours', () => {
    expect(playbackMimeType(meta({ videoCodec: 'hevc' }))).toContain('hev1');
  });

  it('gives up on a container the engine cannot open', () => {
    expect(playbackMimeType(meta({ fileName: 'clip.mkv' }))).toBeNull();
  });

  it('gives up on codecs with no browser equivalent', () => {
    expect(playbackMimeType(meta({ videoCodec: 'prores' }))).toBeNull();
    expect(
      playbackMimeType(
        meta({ audio: { codec: 'pcm_s16le', sampleRate: 48000, channels: 2, channelLayout: 'stereo' } }),
      ),
    ).toBeNull();
  });
});

describe('unsupportedReason', () => {
  it('names the container, the video codec or the audio codec', () => {
    expect(unsupportedReason(meta({ fileName: 'clip.mkv' }))).toContain('.mkv');
    expect(unsupportedReason(meta({ videoCodec: 'hevc' }))).toContain('HEVC');
    expect(
      unsupportedReason(
        meta({ audio: { codec: 'pcm_s16le', sampleRate: 48000, channels: 1, channelLayout: 'mono' } }),
      ),
    ).toContain('PCM_S16LE');
  });
});

describe('containFit', () => {
  it('fits a vertical video into a wide box by its height', () => {
    expect(containFit(1000, 600, 9 / 16)).toEqual({ width: 337, height: 600 });
  });

  it('fits a wide video into a tall box by its width', () => {
    expect(containFit(600, 1000, 16 / 9)).toEqual({ width: 600, height: 337 });
  });

  it('returns nothing for a container that has not been measured yet', () => {
    // The case that used to leave the stage — and the caption overlay — at zero.
    expect(containFit(0, 0, 9 / 16)).toEqual({ width: 0, height: 0 });
  });
});

/* ------------------------------------------------------------------------ */

describe('mediaResponse', () => {
  const fixture = path.join(os.tmpdir(), `appmedia-fixture-${process.pid}.mp4`);
  const body = Buffer.from('0123456789ABCDEF');

  beforeAll(() => {
    fs.writeFileSync(fixture, body);
  });
  afterAll(() => {
    fs.rmSync(fixture, { force: true });
  });

  function request(target: string, init: { method?: string; range?: string } = {}) {
    return {
      url: mediaUrl(target),
      method: init.method ?? 'GET',
      headers: { get: (name: string) => (name.toLowerCase() === 'range' ? init.range ?? null : null) },
    };
  }

  it('streams the whole file when no range is asked for', async () => {
    const response = await mediaResponse(request(fixture));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Length')).toBe(String(body.length));
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(body.toString());
  });

  it('answers a range with 206 and exactly those bytes', async () => {
    const response = await mediaResponse(request(fixture, { range: 'bytes=4-7' }));
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(`bytes 4-7/${body.length}`);
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('4567');
  });

  it('answers HEAD with the size and no body', async () => {
    const response = await mediaResponse(request(fixture, { method: 'HEAD' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(body.length));
    expect(response.body).toBeNull();
  });

  it('reports a missing file rather than throwing', async () => {
    const response = await mediaResponse(request(`${fixture}.missing`));
    expect(response.status).toBe(404);
  });

  it('refuses a directory', async () => {
    const response = await mediaResponse(request(os.tmpdir()));
    expect(response.status).toBe(404);
  });

  it('refuses an unreadable URL', async () => {
    const response = await mediaResponse({
      url: 'not a url',
      method: 'GET',
      headers: { get: () => null },
    });
    expect(response.status).toBe(400);
  });
});
