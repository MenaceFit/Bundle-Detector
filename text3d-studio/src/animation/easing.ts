import type { EasingKind } from '@/types';
import { clamp } from '@/utils/math';

export type EasingFunction = (t: number) => number;

const c1 = 1.70158;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const n1 = 7.5625;
const d1 = 2.75;

export const EASING_FUNCTIONS: Record<Exclude<EasingKind, 'bezier'>, EasingFunction> = {
  hold: () => 0,
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  cubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  // "Out" variants: the overshoot lands at the end of the segment, which is
  // what reads as a snap on an entrance animation.
  back: (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  elastic: (t) => {
    if (t === 0 || t === 1) return t;
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  bounce: (t) => {
    let x = t;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
    return n1 * (x -= 2.625 / d1) * x + 0.984375;
  },
};

export const EASING_LABELS: Record<EasingKind, string> = {
  hold: 'Hold (palier)',
  linear: 'Linear',
  easeIn: 'Ease In',
  easeOut: 'Ease Out',
  easeInOut: 'Ease In Out',
  cubic: 'Cubic',
  back: 'Back',
  elastic: 'Elastic',
  bounce: 'Bounce',
  bezier: 'Bézier',
};

export const EASING_KINDS: EasingKind[] = [
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
  'cubic',
  'back',
  'elastic',
  'bounce',
  'hold',
  'bezier',
];

/**
 * CSS-style cubic-bezier(x1, y1, x2, y2). Solves x(t) = progress by Newton
 * iteration, falling back to bisection when the curve is close to vertical.
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EasingFunction {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;

  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  return (progress: number): number => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;

    let t = progress;
    for (let i = 0; i < 8; i += 1) {
      const x = sampleX(t) - progress;
      if (Math.abs(x) < 1e-6) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= x / d;
    }

    let low = 0;
    let high = 1;
    t = progress;
    for (let i = 0; i < 24; i += 1) {
      const x = sampleX(t);
      if (Math.abs(x - progress) < 1e-6) break;
      if (x > progress) high = t;
      else low = t;
      t = (low + high) / 2;
    }
    return sampleY(t);
  };
}

export function resolveEasing(
  kind: EasingKind,
  bezier?: [number, number, number, number],
): EasingFunction {
  if (kind === 'bezier') {
    const [x1, y1, x2, y2] = bezier ?? [0.4, 0, 0.2, 1];
    return cubicBezier(x1, y1, x2, y2);
  }
  return EASING_FUNCTIONS[kind] ?? EASING_FUNCTIONS.linear;
}

export function applyEasing(
  kind: EasingKind,
  t: number,
  bezier?: [number, number, number, number],
): number {
  return resolveEasing(kind, bezier)(clamp(t, 0, 1));
}
