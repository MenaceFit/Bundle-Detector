import type { KeyframeValue } from '@/types';
import { isValidColor, mixColors } from '@/utils/color';

/**
 * Interpolates between two keyframe values. Numbers blend linearly; colour
 * strings blend channel-wise; anything else steps at the midpoint so enum-like
 * properties still behave predictably.
 */
export function interpolateValue(
  from: KeyframeValue,
  to: KeyframeValue,
  t: number,
): KeyframeValue {
  if (typeof from === 'number' && typeof to === 'number') {
    return from + (to - from) * t;
  }
  if (typeof from === 'string' && typeof to === 'string') {
    if (isValidColor(from) && isValidColor(to)) return mixColors(from, to, t);
    return t < 0.5 ? from : to;
  }
  return t < 0.5 ? from : to;
}
