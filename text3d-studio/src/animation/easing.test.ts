import { describe, expect, it } from 'vitest';
import { applyEasing, cubicBezier, EASING_FUNCTIONS, resolveEasing } from './easing';

describe('easing functions', () => {
  it('anchors every curve at 0 and 1', () => {
    for (const [name, fn] of Object.entries(EASING_FUNCTIONS)) {
      if (name === 'hold') continue;
      expect(fn(0), `${name}(0)`).toBeCloseTo(0, 4);
      expect(fn(1), `${name}(1)`).toBeCloseTo(1, 4);
    }
  });

  it('holds at zero for the whole segment', () => {
    expect(EASING_FUNCTIONS.hold(0.5)).toBe(0);
    expect(EASING_FUNCTIONS.hold(0.99)).toBe(0);
  });

  it('clamps input outside 0..1', () => {
    expect(applyEasing('linear', -1)).toBe(0);
    expect(applyEasing('linear', 4)).toBe(1);
  });

  it('makes easeIn slower than linear at the start', () => {
    expect(EASING_FUNCTIONS.easeIn(0.25)).toBeLessThan(0.25);
  });

  it('makes easeOut faster than linear at the start', () => {
    expect(EASING_FUNCTIONS.easeOut(0.25)).toBeGreaterThan(0.25);
  });

  it('overshoots with back and bounces below 1 with bounce', () => {
    expect(EASING_FUNCTIONS.back(0.85)).toBeGreaterThan(0.85);
    expect(EASING_FUNCTIONS.bounce(0.5)).toBeLessThan(1);
  });
});

describe('cubicBezier', () => {
  it('reproduces the identity curve', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    for (const t of [0, 0.15, 0.5, 0.85, 1]) {
      expect(linear(t)).toBeCloseTo(t, 3);
    }
  });

  it('is monotonic for a standard ease curve', () => {
    const ease = cubicBezier(0.42, 0, 0.58, 1);
    let previous = -1;
    for (let i = 0; i <= 20; i += 1) {
      const value = ease(i / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('is selected by resolveEasing with explicit control points', () => {
    const fn = resolveEasing('bezier', [0, 0, 1, 1]);
    expect(fn(0.4)).toBeCloseTo(0.4, 3);
  });

  it('falls back to linear for an unknown kind', () => {
    const fn = resolveEasing('nope' as never);
    expect(fn(0.3)).toBeCloseTo(0.3, 5);
  });
});
