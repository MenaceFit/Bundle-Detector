import { describe, expect, it } from 'vitest';
import {
  createKeyframe,
  duplicateKeyframe,
  evaluateTrack,
  moveKeyframe,
  removeKeyframe,
  rescaleTrack,
  setKeyframeEasing,
  sortKeyframes,
  upsertKeyframe,
} from './keyframes';
import type { Track } from '@/types';

function track(points: Array<[number, number]>, easing: 'linear' | 'hold' = 'linear'): Track {
  return {
    property: 'transform.x',
    keyframes: points.map(([time, value]) => createKeyframe(time, value, easing)),
  };
}

describe('evaluateTrack', () => {
  it('returns undefined for an empty track so the static value wins', () => {
    expect(evaluateTrack({ property: 'opacity', keyframes: [] }, 1)).toBeUndefined();
  });

  it('holds the first and last values outside the keyframe range', () => {
    const t = track([
      [1, 10],
      [2, 20],
    ]);
    expect(evaluateTrack(t, 0)).toBe(10);
    expect(evaluateTrack(t, 1)).toBe(10);
    expect(evaluateTrack(t, 5)).toBe(20);
  });

  it('interpolates linearly between two keyframes', () => {
    const t = track([
      [0, 0],
      [2, 100],
    ]);
    expect(evaluateTrack(t, 1)).toBeCloseTo(50);
    expect(evaluateTrack(t, 0.5)).toBeCloseTo(25);
  });

  it('picks the right segment with more than two keyframes', () => {
    const t = track([
      [0, 0],
      [1, 100],
      [2, 0],
    ]);
    expect(evaluateTrack(t, 0.5)).toBeCloseTo(50);
    expect(evaluateTrack(t, 1.5)).toBeCloseTo(50);
  });

  it('steps instead of blending when the outgoing keyframe holds', () => {
    const t = track(
      [
        [0, 0],
        [1, 100],
      ],
      'hold',
    );
    expect(evaluateTrack(t, 0.9)).toBe(0);
    expect(evaluateTrack(t, 1)).toBe(100);
  });

  it('blends colour keyframes channel-wise', () => {
    const t: Track = {
      property: 'style.fill.color',
      keyframes: [createKeyframe(0, '#000000', 'linear'), createKeyframe(1, '#ffffff', 'linear')],
    };
    expect(evaluateTrack(t, 0.5)).toBe('#808080');
  });

  it('evaluates correctly even when keyframes are stored out of order', () => {
    const t: Track = {
      property: 'opacity',
      keyframes: [createKeyframe(2, 20, 'linear'), createKeyframe(0, 0, 'linear')],
    };
    expect(evaluateTrack(t, 1)).toBeCloseTo(10);
  });
});

describe('track mutations', () => {
  it('adds a keyframe and keeps the list sorted', () => {
    let t = track([[1, 10]]);
    t = upsertKeyframe(t, 0, 5);
    expect(t.keyframes.map((kf) => kf.time)).toEqual([0, 1]);
  });

  it('replaces the value when a keyframe already sits on that tick', () => {
    let t = track([[1, 10]]);
    t = upsertKeyframe(t, 1, 99);
    expect(t.keyframes).toHaveLength(1);
    expect(t.keyframes[0]?.value).toBe(99);
  });

  it('removes a keyframe by id', () => {
    const t = track([
      [0, 0],
      [1, 1],
    ]);
    const id = t.keyframes[0]!.id;
    expect(removeKeyframe(t, id).keyframes).toHaveLength(1);
  });

  it('re-sorts after moving a keyframe past its neighbour', () => {
    const t = track([
      [0, 0],
      [1, 100],
    ]);
    const moved = moveKeyframe(t, t.keyframes[0]!.id, 2);
    expect(moved.keyframes.map((kf) => kf.value)).toEqual([100, 0]);
  });

  it('never lets a keyframe go negative', () => {
    const t = track([[1, 5]]);
    expect(moveKeyframe(t, t.keyframes[0]!.id, -4).keyframes[0]?.time).toBe(0);
  });

  it('duplicates a keyframe at an offset', () => {
    const t = track([[0, 7]]);
    const duplicated = duplicateKeyframe(t, t.keyframes[0]!.id, 0.5);
    expect(duplicated.keyframes).toHaveLength(2);
    expect(duplicated.keyframes[1]?.value).toBe(7);
    expect(duplicated.keyframes[1]?.time).toBeCloseTo(0.5);
    expect(duplicated.keyframes[1]?.id).not.toBe(t.keyframes[0]!.id);
  });

  it('changes the easing of a single keyframe', () => {
    const t = track([
      [0, 0],
      [1, 1],
    ]);
    const updated = setKeyframeEasing(t, t.keyframes[0]!.id, 'bounce');
    expect(updated.keyframes[0]?.easing).toBe('bounce');
    expect(updated.keyframes[1]?.easing).toBe('linear');
  });

  it('rescales every keyframe when the duration changes', () => {
    const t = track([
      [0, 0],
      [2, 1],
    ]);
    expect(rescaleTrack(t, 0.5).keyframes.map((kf) => kf.time)).toEqual([0, 1]);
  });

  it('sorts without mutating the input array', () => {
    const input = [createKeyframe(2, 1), createKeyframe(0, 0)];
    const sorted = sortKeyframes(input);
    expect(sorted[0]?.time).toBe(0);
    expect(input[0]?.time).toBe(2);
  });
});
