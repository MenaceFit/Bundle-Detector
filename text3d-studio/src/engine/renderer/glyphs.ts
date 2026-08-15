import type { LetterState } from '@/animation/letter';
import type { TextLayout } from '@/engine/text/layout';
import { degToRad } from '@/utils/math';

/** Draws one character with the current context paint settings. */
export type GlyphDraw = (char: string, x: number, y: number) => void;

/**
 * Runs `draw` for every glyph of the layout.
 *
 * With no per-letter states this is a tight loop of positioned draws. When
 * states are present each glyph gets its own transform, pivoting a little above
 * the baseline so rotations and scales look centred on the letter rather than
 * hinged on its foot.
 */
export function paintGlyphs(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  states: LetterState[] | null,
  draw: GlyphDraw,
): void {
  if (!states) {
    for (const glyph of layout.glyphs) {
      if (glyph.char === ' ') continue;
      draw(glyph.char, glyph.x, glyph.baseline);
    }
    return;
  }

  const pivotLift = layout.ascent * 0.4;

  for (const glyph of layout.glyphs) {
    if (glyph.char === ' ') continue;
    const state = states[glyph.index];
    if (!state) {
      draw(glyph.char, glyph.x, glyph.baseline);
      continue;
    }
    if (state.opacity <= 0.001) continue;

    ctx.save();
    ctx.translate(glyph.x + glyph.width / 2 + state.offsetX, glyph.baseline - pivotLift + state.offsetY);
    if (state.rotation !== 0) ctx.rotate(degToRad(state.rotation));
    if (state.scaleX !== 1 || state.scaleY !== 1) {
      ctx.scale(state.scaleX === 0 ? 0.0001 : state.scaleX, state.scaleY === 0 ? 0.0001 : state.scaleY);
    }
    if (state.opacity < 1) ctx.globalAlpha *= state.opacity;
    if (state.blur > 0.01) {
      ctx.filter = ctx.filter === 'none' ? `blur(${state.blur}px)` : `${ctx.filter} blur(${state.blur}px)`;
    }

    draw(glyph.char, -glyph.width / 2, pivotLift);
    ctx.restore();
  }
}
