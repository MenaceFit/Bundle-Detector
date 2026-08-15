import type { Typography } from '@/types';

export interface GlyphInfo {
  char: string;
  /** Global index across the whole text, used by the per-letter stagger. */
  index: number;
  lineIndex: number;
  /** Left edge of the advance box, in layout space. */
  x: number;
  /** Baseline Y, in layout space. */
  baseline: number;
  /** Ink width of the character alone, used as the per-letter pivot. */
  width: number;
  /** Ink width plus letter/word spacing — how far the cursor moves. */
  advance: number;
}

export interface LineInfo {
  text: string;
  glyphs: GlyphInfo[];
  width: number;
  baseline: number;
}

export interface TextLayout {
  lines: LineInfo[];
  glyphs: GlyphInfo[];
  width: number;
  height: number;
  ascent: number;
  descent: number;
  lineAdvance: number;
}

/** Builds the CSS font shorthand used by both measuring and drawing. */
export function fontString(typography: Typography): string {
  const family = typography.fontFamily.includes(',')
    ? typography.fontFamily
    : `"${typography.fontFamily}"`;
  return `${typography.fontStyle} ${typography.fontWeight} ${typography.fontSize}px ${family}, sans-serif`;
}

/**
 * Lays the text out glyph by glyph.
 *
 * Per-character advances (rather than a single fillText) are what make letter
 * spacing, per-letter animation and wave effects possible; the trade-off is
 * that pair kerning is not applied, which is the standard behaviour for motion
 * design tools that animate characters individually.
 */
export function computeLayout(
  ctx: CanvasRenderingContext2D,
  text: string,
  typography: Typography,
): TextLayout {
  ctx.save();
  ctx.font = fontString(typography);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const source = typography.uppercase ? text.toLocaleUpperCase() : text;
  const rawLines = source.split('\n');
  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent || typography.fontSize * 0.8;
  const descent = metrics.fontBoundingBoxDescent || typography.fontSize * 0.2;
  const lineAdvance = typography.fontSize * typography.lineHeight;

  const measured = new Map<string, number>();
  const advanceOf = (char: string): number => {
    const cached = measured.get(char);
    if (cached !== undefined) return cached;
    const width = ctx.measureText(char).width;
    measured.set(char, width);
    return width;
  };

  const wrapped =
    typography.maxWidth && typography.maxWidth > 0
      ? rawLines.flatMap((line) => wrapLine(line, typography, advanceOf))
      : rawLines;

  const lines: LineInfo[] = [];
  const glyphs: GlyphInfo[] = [];
  let globalIndex = 0;
  let maxWidth = 0;

  wrapped.forEach((lineText, lineIndex) => {
    const chars = [...lineText];
    const lineGlyphs: GlyphInfo[] = [];
    let cursor = 0;

    chars.forEach((char, position) => {
      const width = advanceOf(char);
      const advance =
        width +
        (char === ' ' ? typography.wordSpacing : 0) +
        (position < chars.length - 1 ? typography.letterSpacing : 0);

      const glyph: GlyphInfo = {
        char,
        index: globalIndex,
        lineIndex,
        x: cursor,
        baseline: ascent + lineIndex * lineAdvance,
        width,
        advance,
      };
      lineGlyphs.push(glyph);
      glyphs.push(glyph);
      cursor += advance;
      globalIndex += 1;
    });

    const width = cursor;
    if (width > maxWidth) maxWidth = width;
    lines.push({
      text: lineText,
      glyphs: lineGlyphs,
      width,
      baseline: ascent + lineIndex * lineAdvance,
    });
  });

  // Horizontal alignment shifts each line inside the common bounding box.
  for (const line of lines) {
    const shift =
      typography.align === 'center'
        ? (maxWidth - line.width) / 2
        : typography.align === 'right'
          ? maxWidth - line.width
          : 0;
    if (shift === 0) continue;
    for (const glyph of line.glyphs) glyph.x += shift;
  }

  const height = lines.length === 0 ? 0 : (lines.length - 1) * lineAdvance + ascent + descent;

  ctx.restore();

  return { lines, glyphs, width: maxWidth, height, ascent, descent, lineAdvance };
}

function wrapLine(
  line: string,
  typography: Typography,
  advanceOf: (char: string) => number,
): string[] {
  const limit = typography.maxWidth ?? Infinity;
  const words = line.split(' ');
  const output: string[] = [];
  let current = '';

  const widthOf = (value: string): number => {
    let total = 0;
    const chars = [...value];
    chars.forEach((char, i) => {
      total +=
        advanceOf(char) +
        (char === ' ' ? typography.wordSpacing : 0) +
        (i < chars.length - 1 ? typography.letterSpacing : 0);
    });
    return total;
  };

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (widthOf(candidate) > limit && current.length > 0) {
      output.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  output.push(current);
  return output;
}

