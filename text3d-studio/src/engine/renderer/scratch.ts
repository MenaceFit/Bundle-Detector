/**
 * Reusable off-screen canvases.
 *
 * Compositing a layer needs several intermediate buffers per frame — the shape,
 * the face surface, and a couple of small reduced-resolution masks for the
 * shadow and the glow. Allocating them fresh every frame would thrash the GC,
 * and so would recycling a canvas into a *different* size: assigning to
 * `canvas.width` reallocates the backing store and clears it, which costs about
 * as much as a new canvas.
 *
 * The pool therefore keys free lists by exact dimensions, so a steady render
 * loop always gets a same-size buffer back and only pays a `clearRect`.
 */

export interface Scratch {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/** Total pixels allowed to sit idle in the pool (~256 MB of RGBA). */
const MAX_POOLED_PIXELS = 64_000_000;

const freeLists = new Map<string, Scratch[]>();
let pooledPixels = 0;

function key(width: number, height: number): string {
  return `${width}x${height}`;
}

function reset(scratch: Scratch): void {
  const { ctx, canvas } = scratch;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function createCanvas(width: number, height: number): Scratch {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
  if (!ctx) throw new Error("Impossible d'initialiser le contexte 2D du canvas.");
  return { canvas, ctx };
}

export function acquire(width: number, height: number): Scratch {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));

  const list = freeLists.get(key(w, h));
  const reused = list?.pop();
  if (reused) {
    pooledPixels -= w * h;
    reset(reused);
    return reused;
  }

  return createCanvas(w, h);
}

export function release(scratch: Scratch): void {
  const { width, height } = scratch.canvas;
  const pixels = width * height;

  if (pooledPixels + pixels > MAX_POOLED_PIXELS) {
    // Drop it: shrinking to 1x1 lets the browser free the backing store now.
    scratch.canvas.width = 1;
    scratch.canvas.height = 1;
    return;
  }

  reset(scratch);
  const id = key(width, height);
  const list = freeLists.get(id);
  if (list) list.push(scratch);
  else freeLists.set(id, [scratch]);
  pooledPixels += pixels;
}

/** Drops every pooled canvas — used when an export finished with huge buffers. */
export function clearPool(): void {
  for (const list of freeLists.values()) {
    for (const scratch of list) {
      scratch.canvas.width = 1;
      scratch.canvas.height = 1;
    }
  }
  freeLists.clear();
  pooledPixels = 0;
}

/** Pool occupancy, for diagnostics. */
export function poolStats(): { buffers: number; pixels: number } {
  let buffers = 0;
  for (const list of freeLists.values()) buffers += list.length;
  return { buffers, pixels: pooledPixels };
}
