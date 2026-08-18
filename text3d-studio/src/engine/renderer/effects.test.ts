import { describe, expect, it } from 'vitest';
import { blurReduction, glowAlpha } from './effects';

/**
 * These two functions encode the fix for a glow that used to stack blurred
 * copies additively: the halo saturated into a flat, hard-edged blob and each
 * pass blurred the full frame. The maths is what keeps that from coming back.
 */
describe('glowAlpha', () => {
  it('never exceeds full opacity, however high the intensity', () => {
    for (const intensity of [1, 2, 4, 40]) {
      expect(glowAlpha(1, intensity).total).toBeLessThanOrEqual(1);
      expect(glowAlpha(0.9, intensity).lobe).toBeLessThanOrEqual(1);
    }
  });

  it('composes its two lobes to exactly the requested total', () => {
    for (const [opacity, intensity] of [
      [0.3, 1],
      [0.32, 0.9],
      [0.9, 3.5],
      [1, 1],
    ] as const) {
      const { total, lobe } = glowAlpha(opacity, intensity);
      // Two successive source-over draws at `lobe`.
      const composed = 1 - (1 - lobe) ** 2;
      expect(composed).toBeCloseTo(total, 10);
    }
  });

  it('scales linearly with opacity below the clamp', () => {
    expect(glowAlpha(0.25, 1).total).toBeCloseTo(0.25, 10);
    expect(glowAlpha(0.25, 2).total).toBeCloseTo(0.5, 10);
  });

  it('is off when either factor is zero', () => {
    expect(glowAlpha(0, 3).total).toBe(0);
    expect(glowAlpha(0.5, 0).total).toBe(0);
  });

  it('handles non-finite input without producing NaN', () => {
    expect(Number.isFinite(glowAlpha(Number.NaN, 1).lobe)).toBe(true);
  });
});

describe('blurReduction', () => {
  it('keeps full resolution for crisp effects', () => {
    expect(blurReduction(0, 'preview')).toBe(1);
    expect(blurReduction(3, 'preview')).toBe(1);
  });

  it('shrinks as the blur grows, so cost stays roughly constant', () => {
    const small = blurReduction(20, 'preview');
    const large = blurReduction(120, 'preview');
    expect(small).toBeLessThan(1);
    expect(large).toBeLessThan(small);
  });

  it('keeps the effective blur radius near the target', () => {
    for (const blur of [10, 40, 90]) {
      const effective = blur * blurReduction(blur, 'preview');
      expect(effective).toBeGreaterThan(3);
      expect(effective).toBeLessThan(12);
    }
  });

  it('never shrinks past the floor that keeps the silhouette readable', () => {
    expect(blurReduction(10_000, 'preview')).toBeGreaterThanOrEqual(0.06);
  });

  it('reduces less for a final render than for the preview', () => {
    expect(blurReduction(60, 'final')).toBeLessThan(blurReduction(60, 'preview'));
  });
});
