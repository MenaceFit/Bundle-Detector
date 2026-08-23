import { describe, expect, it } from 'vitest';
import { captionTypography, visibleWordIndices, wordState } from './renderer';
import { DEFAULT_CAPTION_ANIMATION, DEFAULT_CAPTION_STYLE } from './presets';
import type { CaptionCue, WordAnimationKind } from './types';

const cue: CaptionCue = {
  id: 'c',
  start: 0,
  end: 3,
  text: 'un deux trois quatre',
  words: [
    { id: 'w0', text: 'un', start: 0, end: 0.5 },
    { id: 'w1', text: 'deux', start: 0.5, end: 1 },
    { id: 'w2', text: 'trois', start: 1, end: 1.5 },
    { id: 'w3', text: 'quatre', start: 1.5, end: 2 },
  ],
};

describe('visibleWordIndices', () => {
  it('shows the whole line in karaoke and full-line modes', () => {
    for (const reveal of ['karaoke', 'all'] as const) {
      const style = { ...DEFAULT_CAPTION_STYLE, reveal };
      expect(visibleWordIndices(cue, 0.7, style)).toEqual([0, 1, 2, 3]);
    }
  });

  it('shows a trailing window in word-by-word mode', () => {
    const style = { ...DEFAULT_CAPTION_STYLE, reveal: 'wordByWord' as const, visibleWords: 2 };
    expect(visibleWordIndices(cue, 1.2, style)).toEqual([1, 2]);
  });

  it('shows a single word when asked for one', () => {
    const style = { ...DEFAULT_CAPTION_STYLE, reveal: 'wordByWord' as const, visibleWords: 1 };
    expect(visibleWordIndices(cue, 1.7, style)).toEqual([3]);
  });

  it('never runs past the beginning of the cue', () => {
    const style = { ...DEFAULT_CAPTION_STYLE, reveal: 'wordByWord' as const, visibleWords: 4 };
    expect(visibleWordIndices(cue, 0.1, style)).toEqual([0]);
  });

  it('shows nothing before the first word is spoken', () => {
    const style = { ...DEFAULT_CAPTION_STYLE, reveal: 'wordByWord' as const, visibleWords: 2 };
    expect(visibleWordIndices(cue, -1, style)).toEqual([]);
  });
});

describe('wordState', () => {
  const animation = DEFAULT_CAPTION_ANIMATION;
  const kinds: WordAnimationKind[] = [
    'none', 'pop', 'bounce', 'scale', 'fade', 'slideUp', 'slideDown', 'slideLeft',
    'slideRight', 'rotate', 'flip', 'blur', 'elastic', 'shake', 'punch', 'glow',
  ];

  it('settles on a neutral state once the entrance is over', () => {
    for (const kind of kinds) {
      const state = wordState(kind, 1, animation);
      expect(state.opacity, kind).toBeCloseTo(1, 5);
      expect(state.scaleX, kind).toBeCloseTo(1, 5);
      expect(state.scaleY, kind).toBeCloseTo(1, 5);
      expect(state.offsetX, kind).toBeCloseTo(0, 5);
      expect(state.offsetY, kind).toBeCloseTo(0, 5);
      expect(state.blur, kind).toBeCloseTo(0, 5);
    }
  });

  it('produces finite values throughout the entrance', () => {
    for (const kind of kinds) {
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const state = wordState(kind, p, animation);
        for (const [key, value] of Object.entries(state)) {
          expect(Number.isFinite(value), `${kind}.${key} at ${p}`).toBe(true);
        }
        expect(state.opacity).toBeGreaterThanOrEqual(0);
        expect(state.opacity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('starts invisible for the fade-based entrances', () => {
    for (const kind of ['fade', 'scale', 'slideUp', 'blur', 'rotate'] as const) {
      expect(wordState(kind, 0, animation).opacity, kind).toBeCloseTo(0, 5);
    }
  });

  it('gives every animation some visible effect at mid-entrance', () => {
    for (const kind of kinds) {
      if (kind === 'none') continue;
      const state = wordState(kind, 0.35, animation);
      const moved =
        Math.abs(state.opacity - 1) > 0.01 ||
        Math.abs(state.scaleX - 1) > 0.01 ||
        Math.abs(state.scaleY - 1) > 0.01 ||
        Math.abs(state.offsetX) > 0.5 ||
        Math.abs(state.offsetY) > 0.5 ||
        Math.abs(state.rotation) > 0.5 ||
        state.blur > 0.1;
      expect(moved, `${kind} does nothing`).toBe(true);
    }
  });

  it('squashes horizontally for flip, without touching the vertical axis', () => {
    const state = wordState('flip', 0.1, animation);
    expect(state.scaleX).toBeLessThan(0.5);
    expect(state.scaleY).toBeCloseTo(1, 5);
  });

  it('never scales to exactly zero, which would make the layer vanish', () => {
    for (const kind of kinds) {
      const state = wordState(kind, 0, animation);
      expect(Math.abs(state.scaleX), kind).toBeGreaterThan(0);
    }
  });

  it('leaves everything untouched for "none"', () => {
    expect(wordState('none', 0.4, animation)).toMatchObject({ opacity: 1, scaleX: 1, scaleY: 1 });
  });
});

describe('captionTypography', () => {
  it('derives the font size from the frame height, so a style is resolution-independent', () => {
    const small = captionTypography(DEFAULT_CAPTION_STYLE, 1080, 608);
    const large = captionTypography(DEFAULT_CAPTION_STYLE, 1920, 1080);
    expect(large.fontSize / small.fontSize).toBeCloseTo(1920 / 1080, 3);
  });

  it('derives the wrap width from the frame width', () => {
    const typography = captionTypography(DEFAULT_CAPTION_STYLE, 1920, 1080);
    expect(typography.maxWidth).toBeCloseTo(1080 * DEFAULT_CAPTION_STYLE.maxWidthRatio, 3);
  });

  it('never produces an unusably small font', () => {
    expect(captionTypography(DEFAULT_CAPTION_STYLE, 1, 1).fontSize).toBeGreaterThanOrEqual(8);
  });
});
