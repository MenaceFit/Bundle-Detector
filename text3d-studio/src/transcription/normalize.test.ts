import { describe, expect, it } from 'vitest';
import {
  applyEmphasis,
  buildSegments,
  lowConfidenceWords,
  normalizeWords,
  suggestEmphasis,
  type RawChunk,
} from './normalize';
import { manualTranscript } from './whisper';
import { estimateProcessingSec, languageLabel, WHISPER_MODELS } from './types';

const chunk = (text: string, start: number | null, end: number | null, confidence?: number): RawChunk => ({
  text,
  timestamp: [start, end],
  ...(confidence === undefined ? {} : { confidence }),
});

describe('normalizeWords', () => {
  it('trims the leading spaces Whisper emits', () => {
    const words = normalizeWords([chunk(' Bonjour', 0, 0.5), chunk(' toi', 0.5, 1)], 1);
    expect(words.map((w) => w.text)).toEqual(['Bonjour', 'toi']);
  });

  it('drops empty chunks', () => {
    const words = normalizeWords([chunk('  ', 0, 0.2), chunk('ok', 0.2, 0.5)], 1);
    expect(words).toHaveLength(1);
  });

  it('keeps timings monotonic even when the model reports overlaps', () => {
    const words = normalizeWords(
      [chunk('un', 0, 1), chunk('deux', 0.4, 1.4), chunk('trois', 0.2, 2)],
      3,
    );
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.end - 1e-9);
    }
  });

  it('never emits a word ending before it starts', () => {
    const words = normalizeWords([chunk('glitch', 2, 1)], 5);
    expect(words[0]!.end).toBeGreaterThan(words[0]!.start);
  });

  it('interpolates a missing end from the next known start, keeping the word', () => {
    const words = normalizeWords([chunk('a', 0, null), chunk('b', 1.5, 2)], 3);
    expect(words).toHaveLength(2);
    expect(words[0]!.end).toBeCloseTo(1.5, 3);
  });

  it('interpolates a missing start from the previous end', () => {
    const words = normalizeWords([chunk('a', 0, 0.7), chunk('b', null, 1.2)], 3);
    expect(words[1]!.start).toBeCloseTo(0.7, 3);
  });

  it('never lets a word run past the audio duration', () => {
    const words = normalizeWords([chunk('fin', 9.5, 30)], 10);
    expect(words[0]!.end).toBeLessThanOrEqual(10);
    expect(words[0]!.start).toBeLessThanOrEqual(10);
  });

  it('handles an entirely untimed transcript without losing words', () => {
    const words = normalizeWords(
      [chunk('un', null, null), chunk('deux', null, null), chunk('trois', null, null)],
      5,
    );
    expect(words).toHaveLength(3);
    expect(words[2]!.start).toBeGreaterThan(words[0]!.start);
  });

  it('returns nothing for no chunks', () => {
    expect(normalizeWords([], 10)).toEqual([]);
  });

  it('keeps confidence when the engine reports it', () => {
    const words = normalizeWords([chunk('peut-être', 0, 1, 0.31)], 2);
    expect(words[0]!.confidence).toBeCloseTo(0.31, 3);
  });

  it('preserves French accents exactly', () => {
    const words = normalizeWords([chunk(' démesuré', 0, 1), chunk(" aujourd'hui", 1, 2)], 3);
    expect(words.map((w) => w.text)).toEqual(['démesuré', "aujourd'hui"]);
  });
});

describe('buildSegments', () => {
  it('breaks on sentence-final punctuation', () => {
    const words = normalizeWords(
      [chunk('Salut', 0, 0.4), chunk('toi.', 0.4, 0.9), chunk('Ça', 1, 1.3), chunk('va', 1.3, 1.6)],
      2,
    );
    const segments = buildSegments(words);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.text).toBe('Salut toi.');
    expect(segments[0]!.wordIds).toHaveLength(2);
  });

  it('emits one segment when there is no punctuation', () => {
    const words = normalizeWords([chunk('a', 0, 1), chunk('b', 1, 2)], 2);
    expect(buildSegments(words)).toHaveLength(1);
  });

  it('has segment bounds matching its words', () => {
    const words = normalizeWords([chunk('a', 0.2, 1), chunk('b.', 1, 2.4)], 3);
    const [segment] = buildSegments(words);
    expect(segment!.start).toBeCloseTo(0.2, 6);
    expect(segment!.end).toBeCloseTo(2.4, 6);
  });
});

describe('review helpers', () => {
  it('surfaces only the words below the confidence threshold', () => {
    const words = normalizeWords(
      [chunk('sûr', 0, 1, 0.95), chunk('Vinted', 1, 2, 0.22), chunk('ok', 2, 3)],
      3,
    );
    const flagged = lowConfidenceWords(
      { language: 'fr', words, segments: [], source: { engine: 'x', model: 'y' } },
      0.5,
    );
    expect(flagged.map((w) => w.text)).toEqual(['Vinted']);
  });

  it('suggests emphasis without ever marking everything', () => {
    const words = normalizeWords(
      'extraordinaire je le dis et je le redis vraiment incroyable maintenant'
        .split(' ')
        .map((w, i) => chunk(w, i * 0.4, i * 0.4 + 0.35)),
      10,
    );
    const ids = suggestEmphasis(words);
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.size).toBeLessThanOrEqual(Math.ceil(words.length * 0.15) + 1);
  });

  it('applies emphasis flags without touching the timings', () => {
    const words = normalizeWords([chunk('incroyable', 0, 1), chunk('non', 1, 2)], 2);
    const marked = applyEmphasis(words, new Set([words[0]!.id]));
    expect(marked[0]!.emphasis).toBe(true);
    expect(marked[1]!.emphasis).toBe(false);
    expect(marked[0]!.start).toBe(words[0]!.start);
  });
});

describe('manual transcript', () => {
  it('spreads the words evenly over the requested range', () => {
    const transcript = manualTranscript('un deux trois quatre', 2, 6);
    expect(transcript.words).toHaveLength(4);
    expect(transcript.words[0]!.start).toBeCloseTo(2, 3);
    expect(transcript.words[3]!.end).toBeCloseTo(6, 3);
    expect(transcript.source.engine).toBe('manual');
  });

  it('produces a usable transcript from a single word', () => {
    const transcript = manualTranscript('seul', 0, 1);
    expect(transcript.words).toHaveLength(1);
    expect(transcript.words[0]!.end).toBeGreaterThan(transcript.words[0]!.start);
  });

  it('ignores extra whitespace', () => {
    expect(manualTranscript('  a   b  ', 0, 2).words).toHaveLength(2);
  });
});

describe('model catalogue', () => {
  it('offers three tiers, each with a real model id', () => {
    for (const tier of ['fast', 'balanced', 'accurate'] as const) {
      expect(WHISPER_MODELS[tier].id).toMatch(/whisper/);
      expect(WHISPER_MODELS[tier].downloadMb).toBeGreaterThan(0);
    }
  });

  it('estimates a longer processing time for a heavier model', () => {
    expect(estimateProcessingSec(60, 'accurate')).toBeGreaterThan(estimateProcessingSec(60, 'fast'));
  });

  it('labels known languages and falls back for unknown ones', () => {
    expect(languageLabel('fr')).toBe('Français');
    expect(languageLabel('xx')).toBe('XX');
  });
});
