import type { Keyframe, KeyframeValue, Track } from '@/types';
import { applyEasing } from './easing';
import { interpolateValue } from './interpolation';
import { generateId } from '@/utils/object';

/** Two keyframes closer than this are considered to sit on the same tick. */
export const KEYFRAME_EPSILON = 1e-4;

export function sortKeyframes(keyframes: Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => a.time - b.time);
}

export function createKeyframe(
  time: number,
  value: KeyframeValue,
  easing: Keyframe['easing'] = 'easeInOut',
): Keyframe {
  return { id: generateId('kf'), time: Math.max(0, time), value, easing };
}

/**
 * Samples a track at `time`.
 *
 * The easing stored on a keyframe governs the segment that *leaves* it, which
 * is what the timeline UI shows between two dots. Returns `undefined` for an
 * empty track so the caller can fall back to the layer's static value.
 */
export function evaluateTrack(track: Track, time: number): KeyframeValue | undefined {
  const keys = track.keyframes;
  if (keys.length === 0) return undefined;

  const sorted = isSorted(keys) ? keys : sortKeyframes(keys);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  if (time <= first.time) return first.value;
  if (time >= last.time) return last.value;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      if (span <= KEYFRAME_EPSILON) return b.value;
      const raw = (time - a.time) / span;
      if (a.easing === 'hold') return a.value;
      const eased = applyEasing(a.easing, raw, a.bezier);
      return interpolateValue(a.value, b.value, eased);
    }
  }

  return last.value;
}

export function findKeyframeAt(track: Track, time: number): Keyframe | undefined {
  return track.keyframes.find((kf) => Math.abs(kf.time - time) <= KEYFRAME_EPSILON);
}

/** Adds a keyframe, or replaces the value of the one already on that tick. */
export function upsertKeyframe(
  track: Track,
  time: number,
  value: KeyframeValue,
  easing: Keyframe['easing'] = 'easeInOut',
): Track {
  const existing = findKeyframeAt(track, time);
  if (existing) {
    return {
      ...track,
      keyframes: track.keyframes.map((kf) => (kf.id === existing.id ? { ...kf, value } : kf)),
    };
  }
  return {
    ...track,
    keyframes: sortKeyframes([...track.keyframes, createKeyframe(time, value, easing)]),
  };
}

export function removeKeyframe(track: Track, keyframeId: string): Track {
  return { ...track, keyframes: track.keyframes.filter((kf) => kf.id !== keyframeId) };
}

export function moveKeyframe(track: Track, keyframeId: string, time: number): Track {
  const next = track.keyframes.map((kf) =>
    kf.id === keyframeId ? { ...kf, time: Math.max(0, time) } : kf,
  );
  return { ...track, keyframes: sortKeyframes(next) };
}

export function duplicateKeyframe(track: Track, keyframeId: string, offset: number): Track {
  const source = track.keyframes.find((kf) => kf.id === keyframeId);
  if (!source) return track;
  const copy: Keyframe = { ...source, id: generateId('kf'), time: Math.max(0, source.time + offset) };
  return { ...track, keyframes: sortKeyframes([...track.keyframes, copy]) };
}

export function setKeyframeEasing(
  track: Track,
  keyframeId: string,
  easing: Keyframe['easing'],
  bezier?: [number, number, number, number],
): Track {
  return {
    ...track,
    keyframes: track.keyframes.map((kf) =>
      kf.id === keyframeId ? { ...kf, easing, ...(bezier ? { bezier } : {}) } : kf,
    ),
  };
}

/** Scales every keyframe time so a track keeps its shape when duration changes. */
export function rescaleTrack(track: Track, factor: number): Track {
  return {
    ...track,
    keyframes: track.keyframes.map((kf) => ({ ...kf, time: kf.time * factor })),
  };
}

function isSorted(keyframes: Keyframe[]): boolean {
  for (let i = 1; i < keyframes.length; i += 1) {
    if (keyframes[i]!.time < keyframes[i - 1]!.time) return false;
  }
  return true;
}
