import type { ExtrusionStyle, Project, TextLayer } from '@/types';
import { computeLayout, fontString, type TextLayout } from '@/engine/text/layout';
import { resolveLayer } from '@/animation/evaluate';
import { computeLetterStates, type LetterState } from '@/animation/letter';
import { paintGlyphs } from './glyphs';
import {
  createFillPaint,
  createGlossPaint,
  createStrokePaint,
  extrusionColorAt,
  layoutBox,
} from './paint';
import { applyChromatic, applyNoise, applySweep, drawGlow, drawShadow } from './effects';
import { warpPerspective } from './warp';
import { acquire, createCanvas, release, type Scratch } from './scratch';
import { degToRad } from '@/utils/math';
import { createLogger } from '@/utils/logger';

const log = createLogger('renderer');

export interface RenderOptions {
  /** Canvas units → device pixels. 2 renders a 1000px project at 2000px. */
  scale: number;
  /** `null` keeps the alpha channel untouched — required for PNG export. */
  background: string | null;
  quality: 'preview' | 'final';
}

/** Hard ceiling so a runaway parameter cannot lock the UI for seconds. */
const MAX_EXTRUSION_STEPS = 120;

let measureScratch: Scratch | null = null;

function measureContext(): CanvasRenderingContext2D {
  if (!measureScratch) measureScratch = createCanvas(8, 8);
  return measureScratch.ctx;
}

/** Layout of a layer at a given time — shared by the renderer and the UI. */
export function layoutForLayer(layer: TextLayer): TextLayout {
  return computeLayout(measureContext(), layer.text, layer.typography);
}

/**
 * Draws the whole project at `time` into `target`.
 *
 * Only layer content is drawn: no checkerboard, no grid, no guides. That is the
 * guarantee behind transparent export — the exporter calls exactly this
 * function, so whatever the preview decorates around it can never leak into a
 * file.
 */
export function renderProject(
  target: CanvasRenderingContext2D,
  project: Project,
  time: number,
  options: RenderOptions,
): void {
  const width = Math.max(1, Math.round(project.canvas.width * options.scale));
  const height = Math.max(1, Math.round(project.canvas.height * options.scale));

  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = 1;
  target.globalCompositeOperation = 'source-over';
  target.filter = 'none';
  target.clearRect(0, 0, width, height);

  if (options.background) {
    target.fillStyle = options.background;
    target.fillRect(0, 0, width, height);
  }

  for (const layer of project.layers) {
    if (!layer.visible) continue;
    try {
      renderTextLayer(target, layer, time, options, width, height);
    } catch (error) {
      log.error(`Échec du rendu du calque « ${layer.name} »`, error);
    }
  }

  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = 1;
  target.globalCompositeOperation = 'source-over';
  target.filter = 'none';
}

function renderTextLayer(
  target: CanvasRenderingContext2D,
  layer: TextLayer,
  time: number,
  options: RenderOptions,
  width: number,
  height: number,
): void {
  const resolved = resolveLayer(layer, time);
  if (resolved.opacity <= 0.001 || resolved.text.length === 0) return;

  const layout = computeLayout(measureContext(), resolved.text, resolved.typography);
  if (layout.glyphs.length === 0) return;

  const states = computeLetterStates(resolved, time, layout.glyphs.length);

  let shape = acquire(width, height);
  buildShape(shape, resolved, layout, states, options, width, height, time);

  if (resolved.effects.noise.enabled) applyNoise(shape, resolved.effects.noise);

  if (resolved.effects.chromatic.enabled && resolved.effects.chromatic.amount > 0) {
    const aberrated = applyChromatic(shape, resolved.effects.chromatic, options.scale);
    release(shape);
    shape = aberrated;
  }

  if (Math.abs(resolved.transform.perspective) > 0.001) {
    const boxHeight = layout.height * resolved.transform.scaleY * resolved.typography.verticalScale;
    const warped = warpPerspective(shape, {
      strength: resolved.transform.perspective,
      pivotX: width / 2 + resolved.transform.x * options.scale,
      pivotY: height / 2 + resolved.transform.y * options.scale,
      halfHeight: Math.max(1, (boxHeight * options.scale) / 2),
      slices: options.quality === 'final' ? 480 : 180,
    });
    release(shape);
    shape = warped;
  }

  target.save();
  target.globalAlpha = Math.min(1, Math.max(0, resolved.opacity));
  target.globalCompositeOperation = resolved.blendMode;

  drawShadow(target, shape, resolved.style.shadow, options.scale, options.quality);
  drawGlow(target, shape, resolved.style.glow, options.scale, options.quality);
  target.drawImage(shape.canvas, 0, 0);

  target.restore();
  release(shape);
}

/**
 * Paints the layer body — extrusion, stroke, face, gloss, sweep — into `shape`.
 * Shadow and glow are derived from the finished silhouette afterwards, so they
 * automatically follow the outline of everything drawn here.
 */
function buildShape(
  shape: Scratch,
  layer: TextLayer,
  layout: TextLayout,
  states: LetterState[] | null,
  options: RenderOptions,
  width: number,
  height: number,
  time: number,
): void {
  const { style } = layer;
  const extrusion = style.extrusion;

  if (extrusion.enabled && extrusion.depth > 0 && extrusion.steps > 0) {
    const blurred = extrusion.blur > 0.01;
    const surface = blurred ? acquire(width, height) : shape;

    withLayerTransform(surface.ctx, layer, layout, options.scale, width, height, (ctx) => {
      drawExtrusion(
        ctx,
        extrusion,
        style.stroke.enabled ? style.stroke.width : 0,
        layout,
        states,
        options.scale,
      );
    });

    if (blurred) {
      shape.ctx.save();
      shape.ctx.filter = `blur(${extrusion.blur * options.scale}px)`;
      shape.ctx.drawImage(surface.canvas, 0, 0);
      shape.ctx.restore();
      release(surface);
    }
  }

  const box = layoutBox(layout);

  withLayerTransform(shape.ctx, layer, layout, options.scale, width, height, (ctx) => {
    if (style.stroke.enabled && style.stroke.width > 0) {
      ctx.strokeStyle = createStrokePaint(ctx, style.stroke, box);
      ctx.lineJoin = style.stroke.join;
      ctx.lineCap = 'round';
      ctx.miterLimit = 3;
      // An "outside" stroke is a double-width centred stroke covered by the
      // face — that keeps corners clean on very heavy display weights.
      ctx.lineWidth = style.stroke.align === 'outside' ? style.stroke.width * 2 : style.stroke.width;
      paintGlyphs(ctx, layout, states, (char, x, y) => ctx.strokeText(char, x, y));
    }
  });

  // The face lives on its own surface so the gloss band can be clipped to it
  // with `source-atop` without spilling over the extruded sides.
  const glossActive = style.gloss.enabled && style.gloss.intensity > 0;
  const sweep = layer.effects.sweep;
  const sweepActive = sweep.enabled && sweep.intensity > 0;
  const faceSurface = glossActive || sweepActive ? acquire(width, height) : shape;

  withLayerTransform(faceSurface.ctx, layer, layout, options.scale, width, height, (ctx) => {
    ctx.fillStyle = createFillPaint(ctx, style.fill, box);
    paintGlyphs(ctx, layout, states, (char, x, y) => ctx.fillText(char, x, y));
  });

  if (glossActive) {
    withLayerTransform(faceSurface.ctx, layer, layout, options.scale, width, height, (ctx) => {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = createGlossPaint(ctx, style.gloss, box);
      // `source-atop` already clips to the face, so the fill only has to cover
      // the text box — a margin for the stroke is enough. Filling a larger area
      // just rasterises pixels that are discarded.
      const margin = Math.max(box.width, box.height) * 0.15;
      ctx.fillRect(
        box.x - margin,
        box.y - margin,
        box.width + margin * 2,
        box.height + margin * 2,
      );
    });
  }

  if (sweepActive) {
    const cycle = ((time * sweep.speed) % 1 + 1) % 1;
    applySweep(faceSurface, {
      // Travel from just off one edge to just off the other.
      position: cycle * 1.4 - 0.2,
      width: sweep.width,
      intensity: sweep.intensity,
      angle: sweep.angle,
      color: sweep.color,
    });
  }

  if (faceSurface !== shape) {
    shape.ctx.drawImage(faceSurface.canvas, 0, 0);
    release(faceSurface);
  }
}

function drawExtrusion(
  ctx: CanvasRenderingContext2D,
  extrusion: ExtrusionStyle,
  strokeWidth: number,
  layout: TextLayout,
  states: LetterState[] | null,
  deviceScale: number,
): void {
  const length = Math.hypot(extrusion.dirX, extrusion.dirY);
  if (length === 0) return;

  const ux = extrusion.dirX / length;
  const uy = extrusion.dirY / length;
  // Slices closer together than ~1 device pixel are redundant: they land on the
  // same pixels as their neighbour. Capping by what the depth can actually
  // resolve keeps shallow extrusions cheap without changing how they look.
  const resolvable = Math.ceil((extrusion.depth * deviceScale) / 1.2);
  const steps = Math.min(
    MAX_EXTRUSION_STEPS,
    Math.max(1, Math.min(Math.round(extrusion.steps), Math.max(1, resolvable))),
  );

  if (strokeWidth > 0) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = strokeWidth * 2;
  }

  // Far slices first so nearer ones paint over them.
  for (let i = steps; i >= 1; i -= 1) {
    const depthRatio = i / steps;
    const offset = extrusion.depth * depthRatio;
    const color = extrusionColorAt(extrusion, depthRatio);

    ctx.save();
    ctx.translate(ux * offset, uy * offset);
    ctx.fillStyle = color;
    if (strokeWidth > 0) {
      ctx.strokeStyle = color;
      paintGlyphs(ctx, layout, states, (char, x, y) => ctx.strokeText(char, x, y));
    }
    paintGlyphs(ctx, layout, states, (char, x, y) => ctx.fillText(char, x, y));
    ctx.restore();
  }
}

/**
 * Sets up layout space on `ctx`: the origin lands on the top-left of the text
 * box, with the layer's position, rotation, skew, scale and anchor applied.
 */
function withLayerTransform(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  layout: TextLayout,
  scale: number,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): void {
  const t = layer.transform;
  const typo = layer.typography;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(width / 2 + t.x * scale, height / 2 + t.y * scale);
  if (t.rotation !== 0) ctx.rotate(degToRad(t.rotation));
  if (t.skewX !== 0 || t.skewY !== 0) {
    ctx.transform(1, Math.tan(degToRad(t.skewY)), Math.tan(degToRad(t.skewX)), 1, 0, 0);
  }
  ctx.scale(
    scale * t.scaleX * typo.horizontalScale || 0.0001,
    scale * t.scaleY * typo.verticalScale || 0.0001,
  );
  ctx.translate(-layout.width * t.anchorX, -layout.height * t.anchorY);

  ctx.font = fontString(typo);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  draw(ctx);
  ctx.restore();
}

/** Bounding box of the text block in canvas units, for guides and overlays. */
export function layerBounds(
  layer: TextLayer,
  layout: TextLayout,
): { x: number; y: number; width: number; height: number } {
  const t = layer.transform;
  const boxWidth = layout.width * t.scaleX * layer.typography.horizontalScale;
  const boxHeight = layout.height * t.scaleY * layer.typography.verticalScale;
  return {
    x: t.x - boxWidth * t.anchorX,
    y: t.y - boxHeight * t.anchorY,
    width: boxWidth,
    height: boxHeight,
  };
}
