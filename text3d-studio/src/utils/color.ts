/**
 * Colour helpers. Everything in the document model is stored as a hex string
 * (`#RRGGBB` or `#RRGGBBAA`); this module is the only place that parses it.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface HSLA {
  h: number;
  s: number;
  l: number;
  a: number;
}

const HEX_RE = /^#?([0-9a-f]{3,8})$/i;

export function parseColor(input: string): RGBA {
  const fallback: RGBA = { r: 0, g: 0, b: 0, a: 1 };
  if (typeof input !== 'string') return fallback;
  const value = input.trim();

  const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgbMatch?.[1]) {
    const parts = rgbMatch[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return {
      r: clamp255(parts[0] ?? 0),
      g: clamp255(parts[1] ?? 0),
      b: clamp255(parts[2] ?? 0),
      a: parts[3] === undefined ? 1 : clamp01(parts[3]),
    };
  }

  const match = HEX_RE.exec(value);
  if (!match?.[1]) return fallback;
  let hex = match[1];
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (hex.length !== 6 && hex.length !== 8) return fallback;

  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

export function toHex(color: RGBA, withAlpha = false): string {
  const part = (n: number): string =>
    Math.round(clamp255(n)).toString(16).padStart(2, '0');
  const base = `#${part(color.r)}${part(color.g)}${part(color.b)}`;
  if (!withAlpha || color.a >= 1) return base;
  return `${base}${Math.round(clamp01(color.a) * 255).toString(16).padStart(2, '0')}`;
}

export function toCss(color: RGBA): string {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${round(color.a)})`;
}

/** Returns a CSS colour string for `hex` scaled by an extra opacity factor. */
export function withAlpha(hex: string, alpha: number): string {
  const color = parseColor(hex);
  return toCss({ ...color, a: clamp01(color.a * alpha) });
}

export function isValidColor(input: string): boolean {
  return HEX_RE.test(input.trim()) || /^rgba?\([^)]+\)$/i.test(input.trim());
}

export function mixColors(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const k = clamp01(t);
  return toHex(
    {
      r: ca.r + (cb.r - ca.r) * k,
      g: ca.g + (cb.g - ca.g) * k,
      b: ca.b + (cb.b - ca.b) * k,
      a: ca.a + (cb.a - ca.a) * k,
    },
    true,
  );
}

export function rgbToHsl({ r, g, b, a }: RGBA): HSLA {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l, a };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;

  return { h: h * 360, s, l, a };
}

export function hslToRgb({ h, s, l, a }: HSLA): RGBA {
  const hn = ((h % 360) + 360) / 360 - Math.floor(((h % 360) + 360) / 360);
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v, a };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, hn + 1 / 3) * 255,
    g: hueToRgb(p, q, hn) * 255,
    b: hueToRgb(p, q, hn - 1 / 3) * 255,
    a,
  };
}

function hueToRgb(p: number, q: number, t: number): number {
  let tn = t;
  if (tn < 0) tn += 1;
  if (tn > 1) tn -= 1;
  if (tn < 1 / 6) return p + (q - p) * 6 * tn;
  if (tn < 1 / 2) return q;
  if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
  return p;
}

export function shiftHue(hex: string, degrees: number): string {
  const hsl = rgbToHsl(parseColor(hex));
  return toHex(hslToRgb({ ...hsl, h: hsl.h + degrees }), true);
}

/** Multiplies lightness; `amount > 1` brightens, `< 1` darkens. */
export function scaleLightness(hex: string, amount: number): string {
  const hsl = rgbToHsl(parseColor(hex));
  return toHex(hslToRgb({ ...hsl, l: clamp01(hsl.l * amount) }), true);
}

/**
 * Applies the fill's tone controls. Kept as a pure colour transform so it can be
 * used both by the renderer and by the UI swatches.
 */
export function adjustColor(
  hex: string,
  options: { brightness?: number; contrast?: number; saturation?: number },
): string {
  const { brightness = 1, contrast = 1, saturation = 1 } = options;
  if (brightness === 1 && contrast === 1 && saturation === 1) return hex;

  const rgba = parseColor(hex);
  const hsl = rgbToHsl(rgba);
  const saturated = hslToRgb({ ...hsl, s: clamp01(hsl.s * saturation) });

  const apply = (channel: number): number => {
    const lifted = channel * brightness;
    return clamp255((lifted - 128) * contrast + 128);
  };

  return toHex(
    { r: apply(saturated.r), g: apply(saturated.g), b: apply(saturated.b), a: rgba.a },
    true,
  );
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function clamp255(n: number): number {
  return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
