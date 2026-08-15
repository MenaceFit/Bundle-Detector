import { acquire, type Scratch } from './scratch';

export interface WarpOptions {
  /** -1..1. Positive widens the bottom (camera looking down at the text). */
  strength: number;
  /** Vertical centre of the warp, in device pixels. */
  pivotY: number;
  /** Half-height of the region the warp is calibrated on, in device pixels. */
  halfHeight: number;
  /** Horizontal vanishing centre, in device pixels. */
  pivotX: number;
  /** Number of horizontal slices; more slices = smoother, slower. */
  slices: number;
}

/**
 * Trapezoid perspective.
 *
 * True 3D projection would need WebGL; slicing the rasterised layer into
 * horizontal bands and scaling each one about the vanishing centre produces the
 * same read for text — a receding top or bottom edge — at a fraction of the
 * complexity, and stays sharp because each slice is resampled from the
 * full-resolution source.
 */
export function warpPerspective(source: Scratch, options: WarpOptions): Scratch {
  const { width, height } = source.canvas;
  const out = acquire(width, height);
  const ctx = out.ctx;

  const slices = Math.max(8, Math.floor(options.slices));
  const sliceHeight = height / slices;
  const halfHeight = Math.max(1, options.halfHeight);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (let i = 0; i < slices; i += 1) {
    const sy = i * sliceHeight;
    // Sample the factor at the middle of the slice for a symmetric result.
    const centerY = sy + sliceHeight / 2;
    const normalized = (centerY - options.pivotY) / halfHeight;
    const factor = 1 + options.strength * normalized;
    if (factor <= 0.001) continue;

    // Scale each slice horizontally about the vanishing centre.
    const destWidth = width * factor;
    const destX = options.pivotX * (1 - factor);

    ctx.drawImage(
      source.canvas,
      0,
      sy,
      width,
      sliceHeight + 1,
      destX,
      sy,
      destWidth,
      sliceHeight + 1,
    );
  }

  return out;
}
