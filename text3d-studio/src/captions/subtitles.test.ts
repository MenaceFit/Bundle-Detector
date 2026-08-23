import { describe, expect, it } from 'vitest';
import {
  formatAssTime,
  formatSrtTime,
  formatVttTime,
  parseSrt,
  toAss,
  toAssColor,
  toCaptionJson,
  toSrt,
  toVtt,
} from './subtitles';
import { DEFAULT_CAPTION_STYLE } from './presets';
import type { CaptionTrack } from './types';

const track: CaptionTrack = {
  cues: [
    {
      id: 'c1',
      start: 0.42,
      end: 2.1,
      text: 'Aujourd’hui je vais vous montrer',
      words: [
        { id: 'w1', text: 'Aujourd’hui', start: 0.42, end: 0.78 },
        { id: 'w2', text: 'je', start: 0.79, end: 1.02 },
        { id: 'w3', text: 'vais', start: 1.03, end: 1.16 },
        { id: 'w4', text: 'vous', start: 1.17, end: 1.3 },
        { id: 'w5', text: 'montrer', start: 1.31, end: 2.1 },
      ],
    },
    {
      id: 'c2',
      start: 2.1,
      end: 4.3,
      text: 'exactement comment faire ça',
      words: [
        { id: 'w6', text: 'exactement', start: 2.1, end: 3.0 },
        { id: 'w7', text: 'comment', start: 3.0, end: 3.5 },
        { id: 'w8', text: 'faire', start: 3.5, end: 3.9 },
        { id: 'w9', text: 'ça', start: 3.9, end: 4.3 },
      ],
    },
  ],
};

describe('timestamp formatting', () => {
  it('formats SRT timestamps with a comma', () => {
    expect(formatSrtTime(0.42)).toBe('00:00:00,420');
    expect(formatSrtTime(2.1)).toBe('00:00:02,100');
    expect(formatSrtTime(3661.5)).toBe('01:01:01,500');
  });

  it('formats VTT timestamps with a dot', () => {
    expect(formatVttTime(0.42)).toBe('00:00:00.420');
  });

  it('formats ASS timestamps in centiseconds', () => {
    expect(formatAssTime(0.42)).toBe('0:00:00.42');
    expect(formatAssTime(3661.5)).toBe('1:01:01.50');
  });

  it('carries rounding into the next second instead of printing 1000 ms', () => {
    expect(formatSrtTime(1.9999)).toBe('00:00:02,000');
    expect(formatAssTime(1.9999)).toBe('0:00:02.00');
  });

  it('clamps negative times to zero', () => {
    expect(formatSrtTime(-5)).toBe('00:00:00,000');
  });
});

describe('SRT', () => {
  it('writes the standard block layout', () => {
    const srt = toSrt(track);
    expect(srt).toContain('1\n00:00:00,420 --> 00:00:02,100\nAujourd’hui je vais vous montrer');
    expect(srt).toContain('2\n00:00:02,100 --> 00:00:04,300\nexactement comment faire ça');
  });

  it('numbers cues from 1', () => {
    expect(toSrt(track).trimStart().startsWith('1\n')).toBe(true);
  });

  it('round-trips through the parser with the same timings and text', () => {
    const parsed = parseSrt(toSrt(track));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.start).toBeCloseTo(0.42, 3);
    expect(parsed[0]?.end).toBeCloseTo(2.1, 3);
    expect(parsed[0]?.text).toBe('Aujourd’hui je vais vous montrer');
    expect(parsed[1]?.text).toBe('exactement comment faire ça');
  });

  it('spreads words across a cue when the file carries no word timings', () => {
    const parsed = parseSrt(toSrt(track));
    const words = parsed[0]!.words;
    expect(words).toHaveLength(5);
    expect(words[0]!.start).toBeCloseTo(0.42, 3);
    expect(words[words.length - 1]!.end).toBeCloseTo(2.1, 3);
  });

  it('ignores malformed blocks instead of throwing', () => {
    expect(parseSrt('garbage\n\nnot a cue')).toEqual([]);
    expect(parseSrt('')).toEqual([]);
  });

  it('accepts CRLF line endings', () => {
    const crlf = toSrt(track).replace(/\n/g, '\r\n');
    expect(parseSrt(crlf)).toHaveLength(2);
  });
});

describe('WebVTT', () => {
  it('starts with the WEBVTT signature', () => {
    expect(toVtt(track).startsWith('WEBVTT\n\n')).toBe(true);
  });

  it('uses dot-separated milliseconds', () => {
    expect(toVtt(track)).toContain('00:00:00.420 --> 00:00:02.100');
  });
});

describe('ASS', () => {
  const video = { width: 1080, height: 1920 };

  it('writes the script, style and event sections', () => {
    const ass = toAss(track, DEFAULT_CAPTION_STYLE, video);
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('[Events]');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
  });

  it('emits one dialogue line per cue', () => {
    const lines = toAss(track, DEFAULT_CAPTION_STYLE, video)
      .split('\n')
      .filter((line) => line.startsWith('Dialogue:'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('0:00:00.42,0:00:02.10');
  });

  it('encodes colours as &HAABBGGRR with inverted alpha', () => {
    expect(toAssColor('#FF0000')).toBe('&H000000FF');
    expect(toAssColor('#00FF00')).toBe('&H0000FF00');
    expect(toAssColor('#FFFFFF', 0)).toBe('&HFFFFFFFF');
  });

  it('keeps braces out of the text, since they delimit ASS override tags', () => {
    const risky: CaptionTrack = {
      cues: [{ ...track.cues[0]!, text: 'a {\\b1} b' }],
    };
    const ass = toAss(risky, DEFAULT_CAPTION_STYLE, video);
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(dialogue).not.toContain('{');
  });

  it('keeps commas out of the font name, since they delimit style fields', () => {
    const style = { ...DEFAULT_CAPTION_STYLE, fontFamily: 'Bad, Font' };
    const line = toAss(track, style, video)
      .split('\n')
      .find((l) => l.startsWith('Style: Default'))!;
    expect(line.split(',')).toHaveLength(23);
  });
});

describe('JSON export', () => {
  it('keeps per-word timings', () => {
    const parsed = JSON.parse(toCaptionJson(track, null));
    expect(parsed.cues[0].words).toHaveLength(5);
    expect(parsed.cues[0].words[0]).toMatchObject({ text: 'Aujourd’hui', start: 0.42, end: 0.78 });
  });

  it('records the language and engine when a transcript is supplied', () => {
    const json = JSON.parse(
      toCaptionJson(track, {
        language: 'fr',
        words: [],
        segments: [],
        source: { engine: 'whisper', model: 'base' },
      }),
    );
    expect(json.language).toBe('fr');
    expect(json.source.model).toBe('base');
  });
});
