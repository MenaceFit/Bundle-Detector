import { describe, expect, it } from 'vitest';
import {
  adjustColor,
  hslToRgb,
  isValidColor,
  mixColors,
  parseColor,
  rgbToHsl,
  scaleLightness,
  shiftHue,
  toHex,
  withAlpha,
} from './color';
import { getPath, setPath, deepClone } from './object';
import { formatBytes, formatTimecode, sanitizeFileName } from './format';
import { clamp, createRandom, lerp } from './math';

describe('colour parsing', () => {
  it('parses 6-digit hex', () => {
    expect(parseColor('#FFE500')).toEqual({ r: 255, g: 229, b: 0, a: 1 });
  });

  it('expands 3-digit hex', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('parses 8-digit hex with alpha', () => {
    const parsed = parseColor('#00000080');
    expect(parsed.a).toBeCloseTo(0.502, 2);
  });

  it('parses rgb()/rgba()', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor('rgba(10, 20, 30, 0.5)').a).toBe(0.5);
  });

  it('falls back to black on garbage instead of throwing', () => {
    expect(parseColor('not a colour')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor('')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('validates colour strings', () => {
    expect(isValidColor('#abc')).toBe(true);
    expect(isValidColor('rgb(1,2,3)')).toBe(true);
    expect(isValidColor('purple-ish')).toBe(false);
  });
});

describe('colour maths', () => {
  it('round-trips through HSL', () => {
    for (const hex of ['#FFE500', '#3FA9FF', '#123456', '#ffffff', '#000000']) {
      const rgba = parseColor(hex);
      expect(toHex(hslToRgb(rgbToHsl(rgba)))).toBe(hex.toLowerCase());
    }
  });

  it('mixes two colours', () => {
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixColors('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixColors('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('applies an alpha multiplier without touching the stored colour', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
  });

  it('shifts hue by a full turn back to the same colour', () => {
    expect(shiftHue('#3FA9FF', 360)).toBe('#3fa9ff');
  });

  it('darkens and brightens', () => {
    expect(rgbToHsl(parseColor(scaleLightness('#808080', 0.5))).l).toBeLessThan(0.5);
    expect(rgbToHsl(parseColor(scaleLightness('#808080', 1.5))).l).toBeGreaterThan(0.5);
  });

  it('returns the input unchanged for neutral tone settings', () => {
    expect(adjustColor('#FFE500', { brightness: 1, contrast: 1, saturation: 1 })).toBe('#FFE500');
  });

  it('desaturates towards grey', () => {
    const grey = parseColor(adjustColor('#FF0000', { saturation: 0 }));
    expect(grey.r).toBeCloseTo(grey.g, -1);
    expect(grey.g).toBeCloseTo(grey.b, -1);
  });

  it('clamps channels instead of overflowing', () => {
    const bright = parseColor(adjustColor('#FFE500', { brightness: 4 }));
    expect(bright.r).toBeLessThanOrEqual(255);
  });
});

describe('object helpers', () => {
  it('reads a nested path', () => {
    expect(getPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });

  it('returns undefined for a missing path', () => {
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });

  it('writes a nested path, creating intermediates', () => {
    const target: Record<string, unknown> = {};
    setPath(target, 'style.fill.color', '#fff');
    expect(getPath(target, 'style.fill.color')).toBe('#fff');
  });

  it('deep-clones without sharing references', () => {
    const source = { nested: { list: [1, 2, 3] } };
    const copy = deepClone(source);
    copy.nested.list.push(4);
    expect(source.nested.list).toHaveLength(3);
  });
});

describe('formatting', () => {
  it('formats a timecode', () => {
    expect(formatTimecode(0)).toBe('00:00.000');
    expect(formatTimecode(61.25)).toBe('01:01.250');
    expect(formatTimecode(-5)).toBe('00:00.000');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(1536)).toBe('1.5 Ko');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 Mo');
  });

  it('sanitises file names', () => {
    expect(sanitizeFileName('mon/projet:2024')).toBe('mon-projet-2024');
    expect(sanitizeFileName('   ')).toBe('sans-titre');
  });
});

describe('math helpers', () => {
  it('clamps, including non-finite input', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(Number.NaN, 2, 8)).toBe(2);
  });

  it('interpolates', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });

  it('produces a stable sequence for a given seed', () => {
    const a = createRandom(42);
    const b = createRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
