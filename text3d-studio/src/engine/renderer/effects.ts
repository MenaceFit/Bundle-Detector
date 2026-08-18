import type { ChromaticEffect, GlowStyle, NoiseEffect, ShadowStyle } from '@/types';
import { acquire, createCanvas, release, type Scratch } from './scratch';
import { withAlpha } from '@/utils/color';
import { clamp } from '@/utils/math';

/**
 * Effective blur radius, in pixels, that the reduced-resolution buffers aim
 * for. A Gaussian blur of radius R at full resolution and a blur of radius
 * R·f on a buffer scaled by f are equivalent once the small buffer is scaled
 * back up — the blur has already removed every detail finer than R, so there is
 * nothing left for the extra resolution to carry. Keeping the small radius
 * around 8 px stays well clear of the sampling floor where the halo would start
 * to look faceted.
 */
const TARGET_BLUR_PREVIEW = 8;
const TARGET_BLUR_FINAL = 5;

/** Never shrink below this, or the silhouette itself becomes unrecognisable. */
const MIN_REDUCTION = 0.06;

export type RenderQuality = 'preview' | 'final';

/**
 * Reduction factor for a blur of `blurPx`. Returns 1 for crisp effects, where
 * resolution still matters.
 */
export function blurReduction(blurPx: number, quality: RenderQuality): number {
  if (blurPx <= 3) return 1;
  const target = quality === 'final' ? TARGET_BLUR_FINAL : TARGET_BLUR_PREVIEW;
  return clamp(target / blurPx, MIN_REDUCTION, 1);
}

/**
 * Downscaled, dilated, tinted silhouette of `source`.
 *
 * Dilation samples scale with the radius: a fixed 8-point ring turns a large
 * spread into a visible octagon.
 */
function buildTintedMask(
  source: Scratch,
  color: string,
  spreadPx: number,
  factor: number,
): Scratch {
  const width = Math.max(1, Math.round(source.canvas.width * factor));
  const height = Math.max(1, Math.round(source.canvas.height * factor));
  const radius = spreadPx * factor;

  // Downscale once. Dilating from the full-size source would re-read the whole
  // frame for every ring sample, which is what makes a spread expensive.
  const base = acquire(width, height);
  base.ctx.imageSmoothingEnabled = true;
  base.ctx.imageSmoothingQuality = 'low';
  base.ctx.drawImage(source.canvas, 0, 0, width, height);

  const mask = acquire(width, height);
  const ctx = mask.ctx;

  if (radius > 0.5) {
    const samples = Math.round(clamp(radius * 3, 8, 48));
    for (let i = 0; i < samples; i += 1) {
      const angle = (i / samples) * Math.PI * 2;
      ctx.drawImage(base.canvas, Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
  }
  ctx.drawImage(base.canvas, 0, 0);
  release(base);

  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';

  return mask;
}

/** Blurs a small buffer into a new one of the same size. */
function blurCopy(mask: Scratch, radius: number): Scratch {
  const { width, height } = mask.canvas;
  const out = acquire(width, height);
  if (radius > 0.05) out.ctx.filter = `blur(${radius}px)`;
  out.ctx.drawImage(mask.canvas, 0, 0);
  out.ctx.filter = 'none';
  return out;
}

/** Draws a reduced-resolution layer back over the full frame. */
function compose(
  target: CanvasRenderingContext2D,
  layer: Scratch,
  fullWidth: number,
  fullHeight: number,
  offsetX: number,
  offsetY: number,
  alpha: number,
): void {
  if (alpha <= 0.001) return;
  target.save();
  target.globalAlpha = alpha;
  target.imageSmoothingEnabled = true;
  // Bilinear is enough here and markedly cheaper: the buffer being magnified
  // holds a blurred blob, so it carries no detail that a costlier resampler
  // could recover.
  target.imageSmoothingQuality = 'low';
  target.drawImage(
    layer.canvas,
    0,
    0,
    layer.canvas.width,
    layer.canvas.height,
    offsetX,
    offsetY,
    fullWidth,
    fullHeight,
  );
  target.restore();
}

/** Draws the drop shadow of `shape` onto `target`, underneath the shape itself. */
export function drawShadow(
  target: CanvasRenderingContext2D,
  shape: Scratch,
  shadow: ShadowStyle,
  scale: number,
  quality: RenderQuality,
): void {
  if (!shadow.enabled || shadow.opacity <= 0) return;

  const blurPx = shadow.blur * scale;
  const factor = blurReduction(blurPx, quality);
  const mask = buildTintedMask(shape, shadow.color, shadow.spread * scale, factor);
  const blurred = blurCopy(mask, blurPx * factor);
  release(mask);

  compose(
    target,
    blurred,
    shape.canvas.width,
    shape.canvas.height,
    shadow.x * scale,
    shadow.y * scale,
    clamp(shadow.opacity, 0, 1),
  );
  release(blurred);
}

/**
 * Opacity budget of the glow.
 *
 * `intensity` scales opacity and is *clamped*: it must never be able to push
 * the halo past full opacity, because that is what turns a soft gradient into
 * a flat blob. The returned `lobe` alpha is the value each of the two
 * source-over lobes uses so that they compose to exactly `total`:
 * `1 - (1 - lobe)² = total`.
 */
export function glowAlpha(opacity: number, intensity: number): { total: number; lobe: number } {
  const total = clamp(opacity * intensity, 0, 1);
  return { total, lobe: 1 - Math.sqrt(1 - total) };
}

/**
 * Draws the glow halo of `shape` onto `target`, underneath the shape itself.
 *
 * Two lobes — a wide haze and a tighter core — give the falloff its shape.
 * Compositing is deliberately *normal*, not additive: stacking blurred copies
 * with `lighter` drives the mid-tones of the gradient to full opacity, which
 * collapses the halo into a flat blob with a hard edge. `intensity` therefore
 * scales opacity (clamped) instead of adding passes.
 */
export function drawGlow(
  target: CanvasRenderingContext2D,
  shape: Scratch,
  glow: GlowStyle,
  scale: number,
  quality: RenderQuality,
): void {
  if (!glow.enabled || glow.opacity <= 0 || glow.intensity <= 0) return;

  const { total, lobe: lobeAlpha } = glowAlpha(glow.opacity, glow.intensity);
  if (total <= 0.002) return;

  const blurPx = Math.max(1, glow.blur * scale);
  const factor = blurReduction(blurPx, quality);
  const mask = buildTintedMask(shape, glow.color, 0, factor);

  const wide = blurCopy(mask, blurPx * factor);
  const core = blurCopy(mask, blurPx * factor * 0.4);
  release(mask);

  // Combine the lobes while they are still small, then magnify once. Two
  // source-over draws at `lobeAlpha` accumulate to exactly `total`.
  const combined = acquire(wide.canvas.width, wide.canvas.height);
  combined.ctx.globalAlpha = lobeAlpha;
  combined.ctx.drawImage(wide.canvas, 0, 0);
  combined.ctx.drawImage(core.canvas, 0, 0);
  combined.ctx.globalAlpha = 1;
  release(wide);
  release(core);

  compose(target, combined, shape.canvas.width, shape.canvas.height, 0, 0, 1);
  release(combined);
}

/**
 * Light sweep / shimmer: a bright band travelling across the glyphs. Applied
 * with `source-atop` so it never spills outside the text.
 */
export function applySweep(
  shape: Scratch,
  options: { position: number; width: number; intensity: number; angle: number; color: string },
): void {
  const { width: w, height: h } = shape.canvas;
  const ctx = shape.ctx;
  const radians = (options.angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
  const cx = w / 2;
  const cy = h / 2;

  const gradient = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  const center = options.position;
  const band = Math.max(0.02, options.width) / 2;
  const alpha = Math.min(1, options.intensity);

  const stops: Array<[number, number]> = [
    [0, 0],
    [center - band, 0],
    [center, alpha],
    [center + band, 0],
    [1, 0],
  ];

  let previous = -1;
  for (const [offset, a] of stops) {
    const clamped = Math.max(0, Math.min(1, offset));
    if (clamped <= previous) continue;
    previous = clamped;
    gradient.addColorStop(clamped, withAlpha(options.color, a));
  }

  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/**
 * Splits the shape into a red-shifted and a cyan-shifted copy recombined
 * additively — the usual "chromatic aberration" look.
 */
export function applyChromatic(shape: Scratch, effect: ChromaticEffect, scale: number): Scratch {
  const { width, height } = shape.canvas;
  const offset = effect.amount * scale;
  const radians = (effect.angle * Math.PI) / 180;
  const dx = Math.cos(radians) * offset;
  const dy = Math.sin(radians) * offset;

  const channel = (mask: string, ox: number, oy: number): Scratch => {
    const layer = acquire(width, height);
    layer.ctx.drawImage(shape.canvas, ox, oy);
    layer.ctx.globalCompositeOperation = 'multiply';
    layer.ctx.fillStyle = mask;
    layer.ctx.fillRect(0, 0, width, height);
    // multiply also multiplied the alpha edges; re-clip to the shifted shape.
    layer.ctx.globalCompositeOperation = 'destination-in';
    layer.ctx.drawImage(shape.canvas, ox, oy);
    layer.ctx.globalCompositeOperation = 'source-over';
    return layer;
  };

  const red = channel('#ff0000', dx, dy);
  const cyan = channel('#00ffff', -dx, -dy);

  const out = acquire(width, height);
  out.ctx.drawImage(red.canvas, 0, 0);
  out.ctx.globalCompositeOperation = 'lighter';
  out.ctx.drawImage(cyan.canvas, 0, 0);
  out.ctx.globalCompositeOperation = 'source-over';

  release(red);
  release(cyan);
  return out;
}

let noiseTile: HTMLCanvasElement | null = null;

function getNoiseTile(): HTMLCanvasElement {
  if (noiseTile) return noiseTile;
  const size = 128;
  const scratch = createCanvas(size, size);
  const image = scratch.ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 110 + Math.floor(Math.random() * 90);
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  scratch.ctx.putImageData(image, 0, 0);
  noiseTile = scratch.canvas;
  return noiseTile;
}

/** Adds a light film grain inside the glyphs. */
export function applyNoise(shape: Scratch, effect: NoiseEffect): void {
  if (!effect.enabled || effect.amount <= 0) return;
  const { width, height } = shape.canvas;
  const ctx = shape.ctx;
  const pattern = ctx.createPattern(getNoiseTile(), 'repeat');
  if (!pattern) return;

  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = Math.min(0.6, effect.amount);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
