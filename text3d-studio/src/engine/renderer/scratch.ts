/**
 * Reusable off-screen canvases.
 *
 * Compositing a layer needs two or three intermediate buffers per frame; at
 * 60 fps allocating them fresh would thrash the GC and stall playback. The pool
 * hands out canvases of the requested size and clears them on release.
 */

export interface Scratch {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

const MAX_POOLED = 6;
const pool: Scratch[] = [];

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

  const index = pool.findIndex((s) => s.canvas.width === w && s.canvas.height === h);
  if (index >= 0) {
    const [scratch] = pool.splice(index, 1);
    if (scratch) {
      scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
      scratch.ctx.globalAlpha = 1;
      scratch.ctx.globalCompositeOperation = 'source-over';
      scratch.ctx.filter = 'none';
      scratch.ctx.clearRect(0, 0, w, h);
      return scratch;
    }
  }

  const reused = pool.pop();
  if (reused) {
    reused.canvas.width = w;
    reused.canvas.height = h;
    reused.ctx.setTransform(1, 0, 0, 1, 0, 0);
    reused.ctx.globalAlpha = 1;
    reused.ctx.globalCompositeOperation = 'source-over';
    reused.ctx.filter = 'none';
    return reused;
  }

  return createCanvas(w, h);
}

export function release(scratch: Scratch): void {
  if (pool.length >= MAX_POOLED) return;
  scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
  scratch.ctx.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
  pool.push(scratch);
}

/** Drops every pooled canvas — used when an export finished with huge buffers. */
export function clearPool(): void {
  pool.length = 0;
}
