/**
 * Median-cut colour quantiser.
 *
 * GIF is limited to 256 indexed colours, so the frames have to be reduced to a
 * shared palette. Median cut keeps gradients readable (far better than a fixed
 * web palette) and runs in a few milliseconds on a 5-bit histogram.
 */

export interface Palette {
  /** Flat RGB triplets. */
  colors: Uint8Array;
  size: number;
}

interface Box {
  colors: number[];
  counts: number[];
  min: [number, number, number];
  max: [number, number, number];
}

const BITS = 5;
const SHIFT = 8 - BITS;
const LEVELS = 1 << BITS;

/** Builds a histogram key from an 8-bit RGB triplet. */
function key(r: number, g: number, b: number): number {
  return ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
}

function unkey(value: number): [number, number, number] {
  const r = (value >> (BITS * 2)) & (LEVELS - 1);
  const g = (value >> BITS) & (LEVELS - 1);
  const b = value & (LEVELS - 1);
  // Recentre inside the bucket so colours are not systematically darkened.
  const half = 1 << (SHIFT - 1);
  return [(r << SHIFT) | half, (g << SHIFT) | half, (b << SHIFT) | half];
}

export class ColorCollector {
  private readonly histogram = new Map<number, number>();

  /** Adds the opaque pixels of an RGBA buffer to the histogram. */
  add(pixels: Uint8ClampedArray, alphaThreshold = 128): void {
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]! < alphaThreshold) continue;
      const k = key(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      this.histogram.set(k, (this.histogram.get(k) ?? 0) + 1);
    }
  }

  get isEmpty(): boolean {
    return this.histogram.size === 0;
  }

  build(maxColors: number): Palette {
    const target = Math.max(2, Math.min(256, maxColors));
    const entries = [...this.histogram.entries()];

    if (entries.length === 0) {
      return { colors: new Uint8Array([0, 0, 0]), size: 1 };
    }

    if (entries.length <= target) {
      const colors = new Uint8Array(entries.length * 3);
      entries.forEach(([k], index) => {
        const [r, g, b] = unkey(k);
        colors[index * 3] = r;
        colors[index * 3 + 1] = g;
        colors[index * 3 + 2] = b;
      });
      return { colors, size: entries.length };
    }

    let boxes: Box[] = [makeBox(entries.map(([k]) => k), entries.map(([, c]) => c))];

    while (boxes.length < target) {
      const index = pickBoxToSplit(boxes);
      if (index < 0) break;
      const box = boxes[index]!;
      const split = splitBox(box);
      if (!split) break;
      boxes = [...boxes.slice(0, index), split[0], split[1], ...boxes.slice(index + 1)];
    }

    const colors = new Uint8Array(boxes.length * 3);
    boxes.forEach((box, index) => {
      const [r, g, b] = averageColor(box);
      colors[index * 3] = r;
      colors[index * 3 + 1] = g;
      colors[index * 3 + 2] = b;
    });

    return { colors, size: boxes.length };
  }
}

function makeBox(colors: number[], counts: number[]): Box {
  const min: [number, number, number] = [255, 255, 255];
  const max: [number, number, number] = [0, 0, 0];
  for (const c of colors) {
    const rgb = unkey(c);
    for (let i = 0; i < 3; i += 1) {
      if (rgb[i]! < min[i]!) min[i] = rgb[i]!;
      if (rgb[i]! > max[i]!) max[i] = rgb[i]!;
    }
  }
  return { colors, counts, min, max };
}

function pickBoxToSplit(boxes: Box[]): number {
  let best = -1;
  let bestScore = 0;
  boxes.forEach((box, index) => {
    if (box.colors.length < 2) return;
    const range = Math.max(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2],
    );
    const weight = box.counts.reduce((sum, n) => sum + n, 0);
    const score = range * Math.log2(weight + 1);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

function splitBox(box: Box): [Box, Box] | null {
  const ranges = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const axis = ranges.indexOf(Math.max(...ranges));

  const indices = box.colors.map((_, i) => i);
  indices.sort((a, b) => unkey(box.colors[a]!)[axis]! - unkey(box.colors[b]!)[axis]!);

  const total = box.counts.reduce((sum, n) => sum + n, 0);
  let accumulated = 0;
  let cut = 0;
  for (let i = 0; i < indices.length; i += 1) {
    accumulated += box.counts[indices[i]!]!;
    if (accumulated >= total / 2) {
      cut = i;
      break;
    }
  }
  // Guarantee both halves are non-empty.
  if (cut <= 0) cut = 0;
  if (cut >= indices.length - 1) cut = indices.length - 2;
  if (cut < 0) return null;

  const left = indices.slice(0, cut + 1);
  const right = indices.slice(cut + 1);
  if (left.length === 0 || right.length === 0) return null;

  return [
    makeBox(
      left.map((i) => box.colors[i]!),
      left.map((i) => box.counts[i]!),
    ),
    makeBox(
      right.map((i) => box.colors[i]!),
      right.map((i) => box.counts[i]!),
    ),
  ];
}

function averageColor(box: Box): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  box.colors.forEach((c, index) => {
    const count = box.counts[index]!;
    const rgb = unkey(c);
    r += rgb[0] * count;
    g += rgb[1] * count;
    b += rgb[2] * count;
    total += count;
  });
  if (total === 0) return [0, 0, 0];
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
}

/** Nearest-colour lookup with a memo keyed on the 5-bit bucket. */
export function createPaletteMapper(palette: Palette): (r: number, g: number, b: number) => number {
  const cache = new Map<number, number>();
  return (r, g, b) => {
    const k = key(r, g, b);
    const cached = cache.get(k);
    if (cached !== undefined) return cached;

    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < palette.size; i += 1) {
      const dr = r - palette.colors[i * 3]!;
      const dg = g - palette.colors[i * 3 + 1]!;
      const db = b - palette.colors[i * 3 + 2]!;
      // Weighted to human luminance sensitivity.
      const distance = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    cache.set(k, best);
    return best;
  };
}
