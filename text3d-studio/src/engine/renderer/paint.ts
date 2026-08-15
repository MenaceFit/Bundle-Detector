import type { ExtrusionStyle, FillStyle, GlossStyle, StrokeStyle } from '@/types';
import type { TextLayout } from '@/engine/text/layout';
import { adjustColor, scaleLightness, withAlpha } from '@/utils/color';
import { degToRad } from '@/utils/math';

export interface PaintBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function layoutBox(layout: TextLayout): PaintBox {
  return { x: 0, y: 0, width: Math.max(1, layout.width), height: Math.max(1, layout.height) };
}

/**
 * Endpoints of a linear gradient at `angle` degrees, spanning `box` fully.
 * 0° = left→right, 90° = top→bottom.
 */
function gradientLine(box: PaintBox, angle: number): [number, number, number, number] {
  const radians = degToRad(angle);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  // Half-extent of the box projected onto the gradient direction.
  const half = (Math.abs(dx) * box.width + Math.abs(dy) * box.height) / 2;
  return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half];
}

/** Builds the paint for the text face according to the fill kind. */
export function createFillPaint(
  ctx: CanvasRenderingContext2D,
  fill: FillStyle,
  box: PaintBox,
): string | CanvasGradient {
  const tone = {
    brightness: fill.brightness,
    contrast: fill.contrast,
    saturation: fill.saturation,
  };
  const c1 = adjustColor(fill.color, tone);
  const c2 = adjustColor(fill.color2, tone);
  const c3 = adjustColor(fill.color3, tone);
  const mid = Math.min(0.99, Math.max(0.01, fill.midpoint));

  switch (fill.kind) {
    case 'solid':
      return withAlpha(c1, fill.opacity);

    case 'linear': {
      const [x0, y0, x1, y1] = gradientLine(box, fill.angle);
      const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
      gradient.addColorStop(0, withAlpha(c1, fill.opacity));
      gradient.addColorStop(1, withAlpha(c2, fill.opacity));
      return gradient;
    }

    case 'radial': {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const radius = Math.max(box.width, box.height) / 2;
      const gradient = ctx.createRadialGradient(cx, cy, radius * 0.05, cx, cy, radius);
      gradient.addColorStop(0, withAlpha(c1, fill.opacity));
      gradient.addColorStop(1, withAlpha(c2, fill.opacity));
      return gradient;
    }

    case 'glossy': {
      // Plastic look: bright top half, a hard break at the midpoint, richer bottom.
      const [x0, y0, x1, y1] = gradientLine(box, fill.angle);
      const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
      gradient.addColorStop(0, withAlpha(scaleLightness(c1, 1.18), fill.opacity));
      gradient.addColorStop(Math.max(0.01, mid - 0.02), withAlpha(c1, fill.opacity));
      gradient.addColorStop(mid, withAlpha(c2, fill.opacity));
      gradient.addColorStop(1, withAlpha(scaleLightness(c2, 0.92), fill.opacity));
      return gradient;
    }

    case 'metallic': {
      // Alternating light/dark bands read as brushed metal.
      const [x0, y0, x1, y1] = gradientLine(box, fill.angle);
      const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
      const stops: Array<[number, string]> = [
        [0, scaleLightness(c1, 0.75)],
        [0.18, c1],
        [0.36, scaleLightness(c3, 1.25)],
        [0.5, c2],
        [0.62, scaleLightness(c3, 1.15)],
        [0.8, c1],
        [1, scaleLightness(c2, 0.7)],
      ];
      for (const [offset, color] of stops) {
        gradient.addColorStop(offset, withAlpha(color, fill.opacity));
      }
      return gradient;
    }

    default:
      return withAlpha(c1, fill.opacity);
  }
}

export function createStrokePaint(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeStyle,
  box: PaintBox,
): string | CanvasGradient {
  if (!stroke.gradient) return withAlpha(stroke.color, stroke.opacity);
  const [x0, y0, x1, y1] = gradientLine(box, stroke.angle);
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  gradient.addColorStop(0, withAlpha(stroke.color, stroke.opacity));
  gradient.addColorStop(1, withAlpha(stroke.color2, stroke.opacity));
  return gradient;
}

/**
 * Colour of one extrusion slice. `depth` runs 0 (closest to the face) to 1
 * (furthest away); a gradient darkens the far slices, which is what sells the
 * volume on a flat canvas.
 */
export function extrusionColorAt(extrusion: ExtrusionStyle, depth: number): string {
  if (!extrusion.gradient) return withAlpha(extrusion.color, extrusion.opacity);
  const shade = 1 - depth;
  const base = extrusion.color;
  const far = extrusion.color2;
  const mixed = mix(base, far, 1 - shade);
  return withAlpha(mixed, extrusion.opacity);
}

function mix(a: string, b: string, t: number): string {
  // Local import-free mix to keep this module free of circular dependencies.
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `#${[r, g, bl].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(value: string): [number, number, number] {
  const hex = value.replace('#', '');
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  return [
    parseInt(expanded.slice(0, 2), 16) || 0,
    parseInt(expanded.slice(2, 4), 16) || 0,
    parseInt(expanded.slice(4, 6), 16) || 0,
  ];
}

/**
 * Gloss highlight: a soft band crossing the glyphs. Drawn clipped to the text
 * shape by the renderer, so it only needs to produce the band itself.
 */
export function createGlossPaint(
  ctx: CanvasRenderingContext2D,
  gloss: GlossStyle,
  box: PaintBox,
): CanvasGradient {
  const [x0, y0, x1, y1] = gradientLine(box, gloss.angle);
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  const center = gloss.position;
  const half = Math.max(0.01, gloss.width) / 2;
  const alpha = Math.min(1, gloss.opacity * gloss.intensity);

  const stops: Array<[number, number]> = [
    [0, 0],
    [Math.max(0, center - half), 0],
    [Math.max(0, Math.min(1, center - half * 0.35)), alpha],
    [Math.max(0, Math.min(1, center + half * 0.35)), alpha],
    [Math.min(1, center + half), 0],
    [1, 0],
  ];

  let previous = -1;
  for (const [offset, a] of stops) {
    const clamped = Math.max(0, Math.min(1, offset));
    if (clamped <= previous) continue;
    previous = clamped;
    gradient.addColorStop(clamped, withAlpha(gloss.color, a));
  }
  return gradient;
}
