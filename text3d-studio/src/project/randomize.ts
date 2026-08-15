import type { LayerStyle } from '@/types';
import { cloneStyle, YELLOW_3D_STYLE } from './defaults';
import { hslToRgb, rgbToHsl, parseColor, toHex } from '@/utils/color';

/**
 * Generates a coherent random style: one hue drives the whole harmony, so the
 * result always looks designed rather than noisy. Reuses the reference geometry
 * and only re-rolls colour, depth, direction, shadow and glow.
 */
export function randomStyle(random: () => number = Math.random): LayerStyle {
  const style = cloneStyle(YELLOW_3D_STYLE);
  const hue = random() * 360;
  const saturation = 0.65 + random() * 0.35;

  const face = hex(hue, saturation, 0.55 + random() * 0.12);
  const faceDark = hex(hue + 8, saturation, 0.4);
  const outline = hex(hue, saturation * 0.35, 0.9);
  const sideNear = hex(hue - 6, saturation, 0.32);
  const sideFar = hex(hue - 12, saturation * 0.9, 0.13);

  style.fill.kind = random() < 0.25 ? 'metallic' : random() < 0.5 ? 'linear' : 'glossy';
  style.fill.color = face;
  style.fill.color2 = faceDark;
  style.fill.color3 = hex(hue + 30, saturation * 0.5, 0.92);
  style.fill.angle = 90 + (random() * 30 - 15);

  style.stroke.enabled = random() > 0.15;
  style.stroke.width = 4 + Math.round(random() * 10);
  style.stroke.color = outline;
  style.stroke.color2 = face;

  style.extrusion.enabled = true;
  style.extrusion.depth = 8 + Math.round(random() * 34);
  const angle = random() * Math.PI * 2;
  style.extrusion.dirX = Number((Math.cos(angle) * 6).toFixed(2));
  style.extrusion.dirY = Number((Math.sin(angle) * 6).toFixed(2));
  style.extrusion.steps = 14 + Math.round(random() * 20);
  style.extrusion.color = sideNear;
  style.extrusion.color2 = sideFar;

  style.gloss.enabled = random() > 0.25;
  style.gloss.intensity = 0.4 + random() * 0.8;
  style.gloss.position = 0.18 + random() * 0.3;
  style.gloss.width = 0.18 + random() * 0.28;

  style.shadow.enabled = random() > 0.2;
  style.shadow.x = Math.round(random() * 20 - 10);
  style.shadow.y = Math.round(random() * 26);
  style.shadow.blur = Math.round(10 + random() * 44);
  style.shadow.opacity = 0.2 + random() * 0.35;
  style.shadow.color = hex(hue, saturation * 0.8, 0.1);

  style.glow.enabled = random() > 0.35;
  style.glow.color = hex(hue + (random() * 40 - 20), saturation * 0.7, 0.72);
  style.glow.intensity = 0.5 + random() * 1.8;
  style.glow.blur = Math.round(20 + random() * 60);
  style.glow.opacity = 0.2 + random() * 0.4;

  return style;
}

/** Small random rotation/perspective, applied alongside a style re-roll. */
export function randomTransformTweaks(random: () => number = Math.random): {
  rotation: number;
  perspective: number;
} {
  return {
    rotation: Number(((random() * 12 - 6)).toFixed(1)),
    perspective: Number((random() * 0.5 - 0.25).toFixed(2)),
  };
}

function hex(hue: number, saturation: number, lightness: number): string {
  return toHex(hslToRgb({ h: hue, s: clamp01(saturation), l: clamp01(lightness), a: 1 }));
}

export interface ExtractedPalette {
  face: string;
  outline: string;
  side: string;
  dominant: string;
}

/** Re-derives a harmonised palette from a single colour. */
export function paletteFromColor(color: string): Omit<ExtractedPalette, 'dominant'> {
  const hsl = rgbToHsl(parseColor(color));
  return {
    face: toHex(hslToRgb({ ...hsl, l: clamp01(Math.max(0.5, hsl.l)) })),
    outline: toHex(hslToRgb({ ...hsl, s: hsl.s * 0.35, l: 0.9 })),
    side: toHex(hslToRgb({ ...hsl, l: clamp01(hsl.l * 0.45) })),
  };
}

/**
 * Picks the dominant *chromatic* colour of an image and derives a matching
 * face / outline / side triplet from it.
 *
 * Buckets are scored by frequency weighted by saturation so a photo that is
 * mostly grey background still yields the accent colour a user actually wants
 * to reuse. Runs fully locally — no external service is involved.
 */
export function extractPalette(
  pixels: Uint8ClampedArray,
  alphaThreshold = 128,
): ExtractedPalette | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3]! < alphaThreshold) continue;
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  let best: string | null = null;
  let bestScore = -1;

  for (const bucket of buckets.values()) {
    const rgba = {
      r: bucket.r / bucket.count,
      g: bucket.g / bucket.count,
      b: bucket.b / bucket.count,
      a: 1,
    };
    const hsl = rgbToHsl(rgba);
    // Ignore near-black and near-white, which dominate most artwork.
    const usable = hsl.l > 0.12 && hsl.l < 0.94;
    const score = usable ? bucket.count * (0.2 + hsl.s) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = toHex(rgba);
    }
  }

  if (!best || bestScore <= 0) return null;
  return { ...paletteFromColor(best), dominant: best };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
