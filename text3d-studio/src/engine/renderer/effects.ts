import type { ChromaticEffect, GlowStyle, NoiseEffect, ShadowStyle } from '@/types';
import { acquire, createCanvas, release, type Scratch } from './scratch';
import { withAlpha } from '@/utils/color';

/**
 * Flattens a rendered layer to a single-colour silhouette, optionally dilated
 * by `spread`. This is what shadow and glow are built from: they must follow
 * the outline of the whole composited shape (extrusion + stroke included), not
 * just the glyph fill.
 */
export function buildSilhouette(source: Scratch, color: string, spread: number): Scratch {
  const { width, height } = source.canvas;
  const out = acquire(width, height);
  const ctx = out.ctx;

  if (spread > 0.5) {
    // Cheap dilation: 8 offset copies on a ring of radius `spread`.
    const steps = 8;
    for (let i = 0; i < steps; i += 1) {
      const angle = (i / steps) * Math.PI * 2;
      ctx.drawImage(source.canvas, Math.cos(angle) * spread, Math.sin(angle) * spread);
    }
  }
  ctx.drawImage(source.canvas, 0, 0);

  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';

  return out;
}

/** Draws the drop shadow of `shape` onto `target`, underneath the shape itself. */
export function drawShadow(
  target: CanvasRenderingContext2D,
  shape: Scratch,
  shadow: ShadowStyle,
  scale: number,
): void {
  if (!shadow.enabled || shadow.opacity <= 0) return;

  const silhouette = buildSilhouette(shape, shadow.color, shadow.spread * scale);
  target.save();
  target.globalAlpha = shadow.opacity;
  if (shadow.blur > 0) target.filter = `blur(${shadow.blur * scale}px)`;
  target.drawImage(silhouette.canvas, shadow.x * scale, shadow.y * scale);
  target.restore();
  release(silhouette);
}

/** Draws the glow halo of `shape` onto `target`, underneath the shape itself. */
export function drawGlow(
  target: CanvasRenderingContext2D,
  shape: Scratch,
  glow: GlowStyle,
  scale: number,
): void {
  if (!glow.enabled || glow.opacity <= 0 || glow.intensity <= 0) return;

  const silhouette = buildSilhouette(shape, glow.color, 0);
  const passes = Math.min(4, Math.max(1, Math.round(glow.intensity)));
  const perPass = Math.min(1, (glow.opacity * glow.intensity) / passes);

  target.save();
  target.globalCompositeOperation = 'lighter';
  target.filter = `blur(${Math.max(0.1, glow.blur * scale)}px)`;
  for (let i = 0; i < passes; i += 1) {
    target.globalAlpha = perPass;
    target.drawImage(silhouette.canvas, 0, 0);
  }
  target.restore();
  release(silhouette);
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
