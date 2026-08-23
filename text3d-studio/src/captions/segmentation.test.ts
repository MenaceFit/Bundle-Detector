import { describe, expect, it } from 'vitest';
import {
  activeWordIndex,
  autoWordsPerCue,
  cueAt,
  DEFAULT_SEGMENTATION,
  segmentWords,
} from './segmentation';
import type { WordTimestamp } from './types';

/** Builds evenly spaced words, with optional gaps expressed per index. */
function words(
  spec: Array<[text: string, start: number, end: number]>,
): WordTimestamp[] {
  return spec.map(([text, start, end], i) => ({ id: `w${i}`, text, start, end }));
}

function speak(text: string, wordsPerSecond = 3, gapAfter: Record<number, number> = {}) {
  const parts = text.split(' ');
  const step = 1 / wordsPerSecond;
  let cursor = 0;
  return parts.map((part, i) => {
    const start = cursor;
    const end = start + step * 0.85;
    cursor = end + (gapAfter[i] ?? step * 0.15);
    return { id: `w${i}`, text: part, start, end };
  });
}

describe('segmentWords', () => {
  it('returns nothing for an empty transcript', () => {
    expect(segmentWords([])).toEqual([]);
    expect(segmentWords(words([['   ', 0, 1]]))).toEqual([]);
  });

  it('keeps a single short phrase as one cue', () => {
    const cues = segmentWords(speak('bonjour tout le monde'));
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('bonjour tout le monde');
  });

  it('breaks on a real silence', () => {
    const spoken = speak('première partie deuxième partie', 4, { 1: 1.2 });
    const cues = segmentWords(spoken);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe('première partie');
    expect(cues[1]?.text).toBe('deuxième partie');
  });

  it('breaks on sentence-ending punctuation', () => {
    const cues = segmentWords(speak('c est fini. on recommence'), DEFAULT_SEGMENTATION);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    expect(cues[0]?.text.endsWith('fini.')).toBe(true);
  });

  it('honours an explicit words-per-cue setting', () => {
    const cues = segmentWords(speak('un deux trois quatre cinq six sept huit'), {
      ...DEFAULT_SEGMENTATION,
      wordsPerCue: 2,
      minDurationSec: 0,
    });
    expect(cues.every((cue) => cue.words.length <= 2)).toBe(true);
    expect(cues).toHaveLength(4);
  });

  it('never exceeds the character budget', () => {
    const long = speak(
      'aujourdhui je vais vous montrer exactement comment trouver les meilleures opportunités sur internet rapidement',
    );
    const cues = segmentWords(long, { ...DEFAULT_SEGMENTATION, maxCharacters: 30 });
    for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(30);
  });

  it('never exceeds the duration budget', () => {
    const slow = speak('un deux trois quatre cinq six sept huit neuf dix', 1);
    const cues = segmentWords(slow, { ...DEFAULT_SEGMENTATION, maxDurationSec: 2 });
    for (const cue of cues) expect(cue.end - cue.start).toBeLessThanOrEqual(2.6);
  });

  it('preserves every word, in order, across the cues', () => {
    const spoken = speak('un deux trois quatre cinq six sept huit neuf dix onze douze');
    const cues = segmentWords(spoken);
    const flat = cues.flatMap((cue) => cue.words.map((w) => w.text));
    expect(flat).toEqual(spoken.map((w) => w.text));
  });

  it('produces cues whose bounds match their words exactly', () => {
    const cues = segmentWords(speak('un deux trois quatre cinq six sept huit'));
    for (const cue of cues) {
      expect(cue.start).toBeCloseTo(cue.words[0]!.start, 6);
      expect(cue.end).toBeCloseTo(cue.words[cue.words.length - 1]!.end, 6);
    }
  });

  it('never emits overlapping cues', () => {
    const cues = segmentWords(speak('un deux trois quatre cinq six sept huit neuf dix'));
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end - 1e-9);
    }
  });

  it('merges a cue too brief to read into its neighbour', () => {
    const spoken = words([
      ['salut', 0, 0.12],
      ['toi', 0.13, 1.2],
    ]);
    const cues = segmentWords(spoken, { ...DEFAULT_SEGMENTATION, wordsPerCue: 1 });
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('salut toi');
  });

  it('keeps French accents and apostrophes intact', () => {
    const spoken = speak("aujourd'hui c'est démesuré ça dépasse tout");
    const cues = segmentWords(spoken);
    expect(cues.map((c) => c.text).join(' ')).toBe("aujourd'hui c'est démesuré ça dépasse tout");
  });

  it('keeps English contractions intact', () => {
    const cues = segmentWords(speak("I'm sure you're going to love it don't you think"));
    expect(cues.map((c) => c.text).join(' ')).toContain("I'm sure you're");
  });

  it('survives a word whose end precedes its start', () => {
    const broken = words([['glitch', 2, 1]]);
    const cues = segmentWords(broken);
    expect(cues[0]!.end).toBeGreaterThan(cues[0]!.start);
  });
});

describe('autoWordsPerCue', () => {
  it('gives more words per cue to fast speech, keeping cue duration readable', () => {
    const fast = autoWordsPerCue(speak('a b c d e f g h i j k l', 8));
    const slow = autoWordsPerCue(speak('a b c d e f', 1.2));
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeLessThanOrEqual(8);
    expect(slow).toBeGreaterThanOrEqual(1);
  });

  it('handles a single word', () => {
    expect(autoWordsPerCue(words([['seul', 0, 1]]))).toBe(1);
  });
});

describe('playback lookups', () => {
  const cues = segmentWords(speak('un deux trois quatre cinq six sept huit'), {
    ...DEFAULT_SEGMENTATION,
    wordsPerCue: 2,
    minDurationSec: 0,
  });

  it('finds the cue visible at a given time', () => {
    const cue = cues[1]!;
    expect(cueAt({ cues }, cue.start + 0.01)?.id).toBe(cue.id);
  });

  it('returns nothing before the first cue', () => {
    expect(cueAt({ cues }, -1)).toBeUndefined();
  });

  it('tracks the spoken word inside a cue', () => {
    const cue = cues[0]!;
    expect(activeWordIndex(cue, cue.words[0]!.start + 0.01)).toBe(0);
    expect(activeWordIndex(cue, cue.words[1]!.start + 0.01)).toBe(1);
  });

  it('holds the last spoken word through the gap before the next one', () => {
    const cue = cues[0]!;
    const gap = (cue.words[0]!.end + cue.words[1]!.start) / 2;
    expect(activeWordIndex(cue, gap)).toBe(0);
  });

  it('reports no active word before the cue starts', () => {
    expect(activeWordIndex(cues[0]!, -1)).toBe(-1);
  });
});
