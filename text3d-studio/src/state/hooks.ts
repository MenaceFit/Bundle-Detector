import { useStore } from './store';
import type { TextLayer } from '@/types';
import { getPath } from '@/utils/object';

export function useActiveLayer(): TextLayer {
  return useStore(
    (state) =>
      state.project.layers.find((layer) => layer.id === state.project.activeLayerId) ??
      state.project.layers[0]!,
  );
}

/** Reads one property of the active layer by dotted path. */
export function useLayerValue<T>(path: string): T {
  return useStore((state) => {
    const layer =
      state.project.layers.find((l) => l.id === state.project.activeLayerId) ??
      state.project.layers[0]!;
    return getPath(layer, path) as T;
  });
}

export interface KeyframeStatus {
  /** The property has at least one keyframe. */
  animated: boolean;
  /** A keyframe sits exactly on the playhead. */
  onKeyframe: boolean;
}

export function useKeyframeStatus(path: string): KeyframeStatus {
  return useStore((state) => {
    const layer =
      state.project.layers.find((l) => l.id === state.project.activeLayerId) ??
      state.project.layers[0]!;
    const track = layer.animation.tracks.find((t) => t.property === path);
    if (!track || track.keyframes.length === 0) return NO_KEYFRAMES;
    const onKeyframe = track.keyframes.some((kf) => Math.abs(kf.time - state.time) <= 1e-4);
    return onKeyframe ? ANIMATED_ON : ANIMATED_OFF;
  });
}

// Shared constants keep the selector referentially stable between renders.
const NO_KEYFRAMES: KeyframeStatus = { animated: false, onKeyframe: false };
const ANIMATED_ON: KeyframeStatus = { animated: true, onKeyframe: true };
const ANIMATED_OFF: KeyframeStatus = { animated: true, onKeyframe: false };
