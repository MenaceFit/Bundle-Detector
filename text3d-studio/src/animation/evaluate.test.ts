import { describe, expect, it } from 'vitest';
import { animationEndTime, hasAnimation, resolveLayer } from './evaluate';
import { createKeyframe } from './keyframes';
import { createTextLayer } from '@/project/defaults';
import { computeLetterStates, staggerOrder } from './letter';
import { buildPresetTracks, mergeTracks } from './presets';
import { DEFAULT_TIMELINE } from '@/project/defaults';

describe('resolveLayer', () => {
  it('leaves an unanimated layer untouched', () => {
    const layer = createTextLayer();
    const resolved = resolveLayer(layer, 1.5);
    expect(resolved.transform.x).toBe(layer.transform.x);
    expect(resolved.style.fill.color).toBe(layer.style.fill.color);
  });

  it('applies a numeric track at the requested time', () => {
    const layer = createTextLayer();
    layer.animation.tracks = [
      {
        property: 'transform.x',
        keyframes: [createKeyframe(0, 0, 'linear'), createKeyframe(2, 200, 'linear')],
      },
    ];
    expect(resolveLayer(layer, 1).transform.x).toBeCloseTo(100);
  });

  it('applies a colour track', () => {
    const layer = createTextLayer();
    layer.animation.tracks = [
      {
        property: 'style.fill.color',
        keyframes: [createKeyframe(0, '#000000', 'linear'), createKeyframe(1, '#ffffff', 'linear')],
      },
    ];
    expect(resolveLayer(layer, 0.5).style.fill.color).toBe('#808080');
  });

  it('does not mutate the source layer', () => {
    const layer = createTextLayer();
    layer.animation.tracks = [
      { property: 'opacity', keyframes: [createKeyframe(0, 0.2, 'linear')] },
    ];
    resolveLayer(layer, 1);
    expect(layer.opacity).toBe(1);
  });

  it('ignores a track whose value type does not match the property', () => {
    const layer = createTextLayer();
    layer.animation.tracks = [
      { property: 'transform.x', keyframes: [createKeyframe(0, '#ff0000', 'linear')] },
    ];
    expect(resolveLayer(layer, 0).transform.x).toBe(0);
  });

  it('shifts hues when colour cycling is on, deterministically', () => {
    const layer = createTextLayer();
    layer.effects.colorCycle = { enabled: true, speed: 1, range: 360 };
    const a = resolveLayer(layer, 0.25).style.fill.color;
    const b = resolveLayer(layer, 0.25).style.fill.color;
    expect(a).toBe(b);
    expect(a).not.toBe(layer.style.fill.color);
  });

  it('reports the end of the animation', () => {
    const layer = createTextLayer();
    expect(hasAnimation(layer)).toBe(false);
    layer.animation.tracks = [
      {
        property: 'opacity',
        keyframes: [createKeyframe(0, 0), createKeyframe(2.5, 1)],
      },
    ];
    expect(hasAnimation(layer)).toBe(true);
    expect(animationEndTime(layer)).toBe(2.5);
  });
});

describe('per-letter stagger', () => {
  it('keeps the natural order by default', () => {
    expect(staggerOrder(4, 'normal', 1)).toEqual([0, 1, 2, 3]);
  });

  it('reverses the order', () => {
    expect(staggerOrder(4, 'reverse', 1)).toEqual([3, 2, 1, 0]);
  });

  it('is a permutation for the random order, and stable for a given seed', () => {
    const first = staggerOrder(8, 'random', 99);
    const second = staggerOrder(8, 'random', 99);
    expect(first).toEqual(second);
    expect([...first].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('starts from the middle for the center order', () => {
    expect(staggerOrder(5, 'center', 1)).toEqual([2, 1, 0, 1, 2]);
  });

  it('returns null when nothing per-letter is active', () => {
    expect(computeLetterStates(createTextLayer(), 0, 5)).toBeNull();
  });

  it('staggers the characters over time', () => {
    const layer = createTextLayer();
    layer.animation.perLetter = {
      ...layer.animation.perLetter,
      enabled: true,
      animation: 'fade',
      easing: 'linear',
      delay: 0.1,
      duration: 0.1,
      startTime: 0,
    };

    const atStart = computeLetterStates(layer, 0, 3);
    expect(atStart?.[0]?.opacity).toBe(0);

    const midway = computeLetterStates(layer, 0.1, 3);
    expect(midway?.[0]?.opacity).toBe(1);
    expect(midway?.[1]?.opacity).toBe(0);

    const end = computeLetterStates(layer, 5, 3);
    expect(end?.every((state) => state.opacity === 1)).toBe(true);
  });
});

describe('animation presets', () => {
  it('produces tracks that land on the layer values at the end of an entrance', () => {
    const layer = createTextLayer();
    const tracks = buildPresetTracks('fadeIn', layer, DEFAULT_TIMELINE);
    expect(tracks).toHaveLength(1);
    const keyframes = tracks[0]!.keyframes;
    expect(keyframes[0]?.value).toBe(0);
    expect(keyframes[keyframes.length - 1]?.value).toBe(layer.opacity);
  });

  it('places exits at the end of the timeline', () => {
    const layer = createTextLayer();
    const tracks = buildPresetTracks('fadeOut', layer, { duration: 4, fps: 30, loop: true });
    const last = tracks[0]!.keyframes.at(-1)!;
    expect(last.time).toBeCloseTo(4, 3);
    expect(last.value).toBe(0);
  });

  it('returns loop presets to their starting value', () => {
    const layer = createTextLayer();
    const tracks = buildPresetTracks('floating', layer, DEFAULT_TIMELINE);
    const keyframes = tracks[0]!.keyframes;
    expect(keyframes[0]?.value).toBe(keyframes.at(-1)?.value);
  });

  it('returns nothing for an unknown preset', () => {
    expect(buildPresetTracks('does-not-exist', createTextLayer(), DEFAULT_TIMELINE)).toEqual([]);
  });

  it('replaces same-property tracks when merging', () => {
    const existing = [{ property: 'opacity', keyframes: [createKeyframe(0, 1)] }];
    const incoming = [{ property: 'opacity', keyframes: [createKeyframe(0, 0)] }];
    const merged = mergeTracks(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.keyframes[0]?.value).toBe(0);
  });
});
