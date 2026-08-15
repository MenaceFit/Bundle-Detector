import type { TextLayer } from '@/types';
import { evaluateTrack } from './keyframes';
import { getProperty } from './properties';
import { deepClone, setPath, type Plain } from '@/utils/object';
import { shiftHue } from '@/utils/color';
import { valueNoise } from '@/utils/math';

/**
 * Produces the layer as it should look at `time`: static values overridden by
 * every animated track, then modulated by the time-based effects that are pure
 * parameter changes (colour cycling, jitter).
 *
 * Geometry-level effects (sweep, wave, chromatic) stay in the renderer because
 * they need glyph positions.
 */
export function resolveLayer(layer: TextLayer, time: number): TextLayer {
  const resolved = deepClone(layer);

  for (const track of layer.animation.tracks) {
    const value = evaluateTrack(track, time);
    if (value === undefined) continue;

    const descriptor = getProperty(track.property);
    if (descriptor?.type === 'number' && typeof value !== 'number') continue;
    if (descriptor?.type === 'color' && typeof value !== 'string') continue;

    setPath(resolved as unknown as Plain, track.property, value);
  }

  applyColorCycle(resolved, time);
  applyJitter(resolved, time);

  return resolved;
}

function applyColorCycle(layer: TextLayer, time: number): void {
  const effect = layer.effects.colorCycle;
  if (!effect.enabled || effect.speed === 0) return;

  const phase = (time * effect.speed) % 1;
  const shift = phase * effect.range;
  layer.style.fill.color = shiftHue(layer.style.fill.color, shift);
  layer.style.fill.color2 = shiftHue(layer.style.fill.color2, shift);
  layer.style.fill.color3 = shiftHue(layer.style.fill.color3, shift);
  layer.style.extrusion.color = shiftHue(layer.style.extrusion.color, shift);
  layer.style.extrusion.color2 = shiftHue(layer.style.extrusion.color2, shift);
  layer.style.glow.color = shiftHue(layer.style.glow.color, shift);
}

function applyJitter(layer: TextLayer, time: number): void {
  const effect = layer.effects.jitter;
  if (!effect.enabled || effect.amount === 0) return;

  const t = time * Math.max(0.01, effect.speed);
  layer.transform.x += valueNoise(t, effect.seed) * effect.amount;
  layer.transform.y += valueNoise(t + 37.5, effect.seed) * effect.amount;
  layer.transform.rotation += valueNoise(t + 71.3, effect.seed) * effect.amount * 0.15;
}

/** True when any track carries at least one keyframe. */
export function hasAnimation(layer: TextLayer): boolean {
  return layer.animation.tracks.some((track) => track.keyframes.length > 0);
}

/** Latest keyframe time across all tracks — used to suggest a timeline length. */
export function animationEndTime(layer: TextLayer): number {
  let end = 0;
  for (const track of layer.animation.tracks) {
    for (const keyframe of track.keyframes) {
      if (keyframe.time > end) end = keyframe.time;
    }
  }
  return end;
}
