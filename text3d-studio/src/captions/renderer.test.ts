import { describe, expect, it } from 'vitest';
import { activeMotion, captionTypography, visibleWordIndices, wordState, wordTilt } from './renderer';
import {
  BUILTIN_CAPTION_PRESETS,
  DEFAULT_CAPTION_ANIMATION,
  DEFAULT_CAPTION_STYLE,
} from './presets';
import type { ActiveMotionKind, CaptionCue, WordAnimationKind, WordTimestamp } from './types';

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
    'spring', 'impact', 'whip', 'dropIn', 'zoomBlur', 'swing', 'riseUp', 'flicker',
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

describe('activeMotion', () => {
  const kinds: ActiveMotionKind[] = ['none', 'pulse', 'breathe', 'wobble', 'float'];

  it('is inert when disabled or at zero amplitude', () => {
    for (const kind of kinds) {
      expect(activeMotion(kind, 0.4, 0), kind).toEqual({ scale: 1, offsetY: 0, rotation: 0 });
    }
    expect(activeMotion('none', 0.4, 1)).toEqual({ scale: 1, offsetY: 0, rotation: 0 });
  });

  it('stays finite and sane over a long hold', () => {
    for (const kind of kinds) {
      for (let t = 0; t < 12; t += 0.13) {
        const motion = activeMotion(kind, t, 1);
        expect(Number.isFinite(motion.scale), `${kind} @ ${t}`).toBe(true);
        expect(motion.scale).toBeGreaterThan(0.8);
        expect(motion.scale).toBeLessThan(1.2);
        expect(Math.abs(motion.offsetY)).toBeLessThan(20);
        expect(Math.abs(motion.rotation)).toBeLessThan(10);
      }
    }
  });

  it('depends only on the elapsed time, so a scrub reproduces the frame exactly', () => {
    // The preview and the export must agree on the same instant; a motion keyed
    // to the wall clock would make them differ.
    for (const kind of kinds) {
      expect(activeMotion(kind, 0.37, 1), kind).toEqual(activeMotion(kind, 0.37, 1));
    }
  });

  it('actually moves something for every kind but "none"', () => {
    for (const kind of kinds) {
      if (kind === 'none') continue;
      let moved = false;
      for (let t = 0; t < 1.2; t += 0.02) {
        const motion = activeMotion(kind, t, 1);
        if (
          Math.abs(motion.scale - 1) > 0.005 ||
          Math.abs(motion.offsetY) > 0.5 ||
          Math.abs(motion.rotation) > 0.3
        ) {
          moved = true;
          break;
        }
      }
      expect(moved, `${kind} does nothing`).toBe(true);
    }
  });

  it('ignores a time that is not a number', () => {
    expect(activeMotion('pulse', Number.NaN, 1)).toEqual({ scale: 1, offsetY: 0, rotation: 0 });
  });
});

describe('wordTilt', () => {
  const word: WordTimestamp = { id: 'w42', text: 'viral', start: 0, end: 1 };

  it('is off at zero', () => {
    expect(wordTilt(word, 0)).toBe(0);
  });

  it('gives the same word the same angle every time', () => {
    expect(wordTilt(word, 8)).toBe(wordTilt({ ...word }, 8));
  });

  it('stays inside the requested range', () => {
    for (let i = 0; i < 200; i += 1) {
      const angle = wordTilt({ id: `w${i}`, text: `mot${i}`, start: 0, end: 1 }, 8);
      expect(Math.abs(angle)).toBeLessThanOrEqual(8);
    }
  });

  it('spreads angles both ways instead of leaning everything one side', () => {
    const angles = Array.from({ length: 60 }, (_, i) =>
      wordTilt({ id: `w${i}`, text: `mot${i}`, start: 0, end: 1 }, 8),
    );
    expect(angles.some((a) => a > 1)).toBe(true);
    expect(angles.some((a) => a < -1)).toBe(true);
  });
});

describe('builtin presets', () => {
  it('all carry a complete style and animation', () => {
    for (const preset of BUILTIN_CAPTION_PRESETS) {
      for (const key of Object.keys(DEFAULT_CAPTION_STYLE)) {
        expect(preset.style, `${preset.id}.${key}`).toHaveProperty(key);
      }
      for (const key of Object.keys(DEFAULT_CAPTION_ANIMATION)) {
        expect(preset.animation, `${preset.id}.${key}`).toHaveProperty(key);
      }
    }
  });

  it('have unique ids', () => {
    const ids = BUILTIN_CAPTION_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('offer several single-word styles, which is what short video needs', () => {
    const single = BUILTIN_CAPTION_PRESETS.filter(
      (preset) => preset.style.reveal === 'wordByWord' && preset.style.visibleWords === 1,
    );
    expect(single.length).toBeGreaterThanOrEqual(3);
  });

  it('keep every word entrance within the time a word is on screen', () => {
    for (const preset of BUILTIN_CAPTION_PRESETS) {
      // A word lasts a few tenths of a second; an entrance longer than that
      // would never finish, and the caption would never look settled.
      expect(preset.animation.wordDuration, preset.id).toBeLessThanOrEqual(0.4);
    }
  });
});
