import type { LetterOrder, PerLetterConfig, TextLayer } from '@/types';
import { applyEasing } from './easing';
import { clamp, createRandom } from '@/utils/math';

/** Per-character delta applied on top of the resolved layer transform. */
export interface LetterState {
  opacity: number;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  blur: number;
}

export const NEUTRAL_LETTER: LetterState = {
  opacity: 1,
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  blur: 0,
};

/**
 * Maps a character index to its position in the stagger sequence. `random` is
 * seeded so playback and export produce the exact same ordering.
 */
export function staggerOrder(count: number, order: LetterOrder, seed: number): number[] {
  const indices = Array.from({ length: count }, (_, i) => i);

  switch (order) {
    case 'reverse':
      return indices.map((i) => count - 1 - i);
    case 'random': {
      const random = createRandom(seed);
      const shuffled = [...indices];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const a = shuffled[i]!;
        shuffled[i] = shuffled[j]!;
        shuffled[j] = a;
      }
      // shuffled[p] = character index at stagger position p → invert it.
      const positions = new Array<number>(count).fill(0);
      shuffled.forEach((charIndex, position) => {
        positions[charIndex] = position;
      });
      return positions;
    }
    case 'center': {
      const middle = (count - 1) / 2;
      return indices.map((i) => Math.round(Math.abs(i - middle)));
    }
    case 'edges': {
      const middle = (count - 1) / 2;
      return indices.map((i) => Math.round(middle - Math.abs(i - middle)));
    }
    case 'normal':
    default:
      return indices;
  }
}

/**
 * Builds the animation state of every character at `time`.
 *
 * Returns `null` when neither the per-letter animation nor the wave effect is
 * active, letting the renderer take its fast path and draw whole lines at once.
 */
export function computeLetterStates(
  layer: TextLayer,
  time: number,
  count: number,
): LetterState[] | null {
  const config = layer.animation.perLetter;
  const wave = layer.effects.wave;
  const perLetterActive = config.enabled && count > 0;
  const waveActive = wave.enabled && wave.amplitude !== 0 && count > 0;

  if (!perLetterActive && !waveActive) return null;

  const order = perLetterActive ? staggerOrder(count, config.order, config.seed) : [];
  const states: LetterState[] = [];

  for (let i = 0; i < count; i += 1) {
    const state: LetterState = { ...NEUTRAL_LETTER };

    if (perLetterActive) {
      const position = order[i] ?? i;
      const start = config.startTime + position * config.delay;
      const duration = Math.max(0.0001, config.duration);
      const raw = clamp((time - start) / duration, 0, 1);
      const progress = applyEasing(config.easing, raw);
      applyLetterAnimation(state, config, progress);
    }

    if (waveActive) {
      const phase = i * wave.frequency - time * wave.speed * Math.PI * 2;
      state.offsetY += Math.sin(phase) * wave.amplitude;
    }

    states.push(state);
  }

  return states;
}

function applyLetterAnimation(
  state: LetterState,
  config: PerLetterConfig,
  progress: number,
): void {
  const remaining = 1 - progress;

  switch (config.animation) {
    case 'fade':
      state.opacity = progress;
      break;
    case 'scale':
      state.opacity = progress;
      state.scaleX = state.scaleY = 1 - remaining * (1 - config.scale);
      break;
    case 'pop':
      state.opacity = Math.min(1, progress * 2);
      state.scaleX = state.scaleY = 1 + Math.sin(progress * Math.PI) * 0.35 - remaining;
      break;
    case 'rotate':
      state.opacity = progress;
      state.rotation = remaining * config.rotation;
      state.scaleX = state.scaleY = 1 - remaining * (1 - config.scale);
      break;
    case 'slideUp':
      state.opacity = progress;
      state.offsetY = remaining * config.distance;
      break;
    case 'slideDown':
      state.opacity = progress;
      state.offsetY = -remaining * config.distance;
      break;
    case 'slideLeft':
      state.opacity = progress;
      state.offsetX = remaining * config.distance;
      break;
    case 'slideRight':
      state.opacity = progress;
      state.offsetX = -remaining * config.distance;
      break;
    case 'bounce': {
      state.opacity = Math.min(1, progress * 3);
      // Damped sine settling on the baseline.
      const damping = remaining ** 2;
      state.offsetY = -Math.sin(progress * Math.PI * 3) * config.distance * damping;
      break;
    }
    case 'blur':
      state.opacity = progress;
      state.blur = remaining * config.blur;
      break;
    case 'flip3d':
      state.opacity = Math.min(1, progress * 1.6);
      // Horizontal squash reads as a Y-axis rotation on a 2D canvas.
      state.scaleX = Math.max(0.02, Math.abs(Math.cos(remaining * Math.PI * 0.5)));
      break;
    default:
      state.opacity = progress;
  }
}
