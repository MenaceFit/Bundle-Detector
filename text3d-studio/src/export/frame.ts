import type { Project } from '@/types';
import { renderProject } from '@/engine/renderer';
import { createCanvas, type Scratch } from '@/engine/renderer/scratch';

export interface FrameOptions {
  width: number;
  height: number;
  /** `null` keeps alpha = 0 outside the glyphs. */
  background: string | null;
}

export interface FrameRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  draw(time: number): void;
  dispose(): void;
}

/**
 * Builds a renderer that draws project frames at an arbitrary output size.
 *
 * The project is rendered at its own aspect ratio and centred inside the export
 * frame, so a 1200×800 composition exported to 2048×2048 keeps its proportions
 * instead of being stretched.
 */
export function createFrameRenderer(project: Project, options: FrameOptions): FrameRenderer {
  const output = createCanvas(options.width, options.height);
  const scale = Math.min(
    options.width / project.canvas.width,
    options.height / project.canvas.height,
  );

  const innerWidth = Math.max(1, Math.round(project.canvas.width * scale));
  const innerHeight = Math.max(1, Math.round(project.canvas.height * scale));
  const offsetX = Math.round((options.width - innerWidth) / 2);
  const offsetY = Math.round((options.height - innerHeight) / 2);

  const needsCompositing = innerWidth !== options.width || innerHeight !== options.height;
  const inner: Scratch | null = needsCompositing ? createCanvas(innerWidth, innerHeight) : null;

  return {
    canvas: output.canvas,
    ctx: output.ctx,

    draw(time: number): void {
      if (inner) {
        renderProject(inner.ctx, project, time, {
          scale,
          background: null,
          quality: 'final',
        });
        output.ctx.setTransform(1, 0, 0, 1, 0, 0);
        output.ctx.globalCompositeOperation = 'source-over';
        output.ctx.clearRect(0, 0, options.width, options.height);
        if (options.background) {
          output.ctx.fillStyle = options.background;
          output.ctx.fillRect(0, 0, options.width, options.height);
        }
        output.ctx.drawImage(inner.canvas, offsetX, offsetY);
      } else {
        renderProject(output.ctx, project, time, {
          scale,
          background: options.background,
          quality: 'final',
        });
      }
    },

    dispose(): void {
      output.canvas.width = 0;
      output.canvas.height = 0;
      if (inner) {
        inner.canvas.width = 0;
        inner.canvas.height = 0;
      }
    },
  };
}

/** Timestamps of every frame of an animation export, in seconds. */
export function frameTimes(duration: number, fps: number): number[] {
  const count = Math.max(1, Math.round(duration * fps));
  const times: number[] = [];
  for (let i = 0; i < count; i += 1) times.push(i / fps);
  return times;
}
