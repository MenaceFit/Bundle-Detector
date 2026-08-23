import type { Project, TextLayer, Typography } from '@/types';
import { createProject, createTextLayer } from '@/project/defaults';
import { fontString } from '@/engine/text/layout';
import { renderProject } from '@/engine/renderer';
import { acquire, createCanvas, release, type Scratch } from '@/engine/renderer/scratch';
import { applyEasing } from '@/animation/easing';
import { clamp } from '@/utils/math';
import { withAlpha } from '@/utils/color';
import { activeWordIndex, cueAt } from './segmentation';
import type {
  CaptionAnimation,
  CaptionCue,
  CaptionStyle,
  CaptionTrack,
  WordAnimationKind,
  WordTimestamp,
} from './types';

/**
 * Caption rendering.
 *
 * There is no second graphics engine: a caption frame is assembled as a normal
 * `Project` holding one text layer per visible word, and handed to the very
 * same `renderProject()` the 3D workspace uses. Every fill, stroke, extrusion,
 * gloss, shadow and glow therefore behaves identically in both places, and a
 * style authored in one is valid in the other.
 *
 * One layer per *word* (rather than one for the whole line) is what makes
 * per-word colour, scale and entrance animation possible while keeping the
 * line's typographic layout exact — positions come from a single measured
 * layout of the full cue, including its line wrapping.
 */

let measureScratch: Scratch | null = null;

function measureContext(): CanvasRenderingContext2D {
  if (!measureScratch) measureScratch = createCanvas(8, 8);
  return measureScratch.ctx;
}

export interface CaptionFrameOptions {
  track: CaptionTrack;
  style: CaptionStyle;
  animation: CaptionAnimation;
  /** Output size in pixels; the style is expressed in ratios of it. */
  width: number;
  height: number;
  time: number;
}

interface WordBox {
  word: WordTimestamp;
  index: number;
  /** Centre of the word in layout space. */
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

/** Per-word animation state at a given time. */
interface WordState {
  opacity: number;
  /** Separate axes: a 3D flip is a horizontal squash on a 2D canvas. */
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
  blur: number;
}

const NEUTRAL: WordState = {
  opacity: 1,
  scaleX: 1,
  scaleY: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  blur: 0,
};

function uniform(state: WordState, value: number): void {
  // Never exactly zero: a singular transform matrix makes the word disappear
  // outright instead of growing from nothing.
  const safe = Math.max(0.001, value);
  state.scaleX = safe;
  state.scaleY = safe;
}

export function captionTypography(style: CaptionStyle, height: number, width: number): Typography {
  return {
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    fontStyle: 'normal',
    fontSize: Math.max(8, style.fontSizeRatio * height),
    letterSpacing: style.letterSpacing,
    wordSpacing: 0,
    lineHeight: style.lineHeight,
    align: 'center',
    maxWidth: Math.max(64, style.maxWidthRatio * width),
    horizontalScale: 1,
    verticalScale: 1,
    uppercase: style.uppercase,
  };
}

/**
 * Lays a cue out word by word.
 *
 * The engine's own line breaking re-splits the string on spaces, which loses
 * the mapping between a glyph and the word it came from — and with it the
 * ability to colour or animate individual words. So the packing is done here at
 * word granularity: each word is measured with the exact same font, greedily
 * packed into lines within `maxWidth`, then centred. Positions therefore stay
 * bound to `cue.words` no matter how the line wraps.
 */
export function measureWords(cue: CaptionCue, typography: Typography): {
  layout: { width: number; height: number; ascent: number; descent: number };
  boxes: WordBox[];
} {
  const ctx = measureContext();
  ctx.save();
  ctx.font = fontString(typography);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent || typography.fontSize * 0.8;
  const descent = metrics.fontBoundingBoxDescent || typography.fontSize * 0.2;
  const lineAdvance = typography.fontSize * typography.lineHeight;
  const spaceWidth = ctx.measureText(' ').width + typography.letterSpacing;
  const limit = typography.maxWidth ?? Infinity;

  const measured = cue.words.map((word, index) => {
    const text = typography.uppercase ? word.text.toLocaleUpperCase() : word.text;
    const chars = [...text];
    // Letter spacing sits between glyphs, so a word of n chars carries n-1 gaps.
    const width =
      ctx.measureText(text).width + Math.max(0, chars.length - 1) * typography.letterSpacing;
    return { word, index, text, width };
  });

  ctx.restore();

  interface Line {
    entries: typeof measured;
    width: number;
  }

  const lines: Line[] = [];
  let current: Line = { entries: [], width: 0 };

  for (const entry of measured) {
    const extra = current.entries.length === 0 ? 0 : spaceWidth;
    if (current.entries.length > 0 && current.width + extra + entry.width > limit) {
      lines.push(current);
      current = { entries: [], width: 0 };
    }
    current.width += (current.entries.length === 0 ? 0 : spaceWidth) + entry.width;
    current.entries.push(entry);
  }
  if (current.entries.length > 0) lines.push(current);

  const blockWidth = lines.reduce((max, line) => Math.max(max, line.width), 0);
  const blockHeight =
    lines.length === 0 ? 0 : (lines.length - 1) * lineAdvance + ascent + descent;

  const boxes: WordBox[] = [];
  lines.forEach((line, lineIndex) => {
    // Centre each line inside the block.
    let cursor = (blockWidth - line.width) / 2;
    const baseline = ascent + lineIndex * lineAdvance;
    for (const entry of line.entries) {
      boxes.push({
        word: entry.word,
        index: entry.index,
        centerX: cursor + entry.width / 2,
        centerY: baseline - ascent + (ascent + descent) / 2,
        width: entry.width,
        height: ascent + descent,
      });
      cursor += entry.width + spaceWidth;
    }
  });

  return { layout: { width: blockWidth, height: blockHeight, ascent, descent }, boxes };
}

/**
 * Word entrance animation.
 *
 * `progress` runs 0→1 over `wordDuration`, starting when the word is spoken
 * (plus its stagger). The animation only ever *decorates* a timing that comes
 * from the audio — it never shifts when a word becomes visible.
 */
export function wordState(
  kind: WordAnimationKind,
  progress: number,
  animation: CaptionAnimation,
): WordState {
  if (kind === 'none' || progress >= 1) return NEUTRAL;
  const p = clamp(progress, 0, 1);
  const remaining = 1 - p;
  const state: WordState = { ...NEUTRAL };

  switch (kind) {
    case 'fade':
      state.opacity = p;
      break;
    case 'scale':
      state.opacity = p;
      uniform(state, animation.scaleFrom + (1 - animation.scaleFrom) * p);
      break;
    case 'pop':
      state.opacity = Math.min(1, p * 2.5);
      // Overshoot then settle, without pulling in a spring library.
      uniform(state, animation.scaleFrom + (1 - animation.scaleFrom) * applyEasing('back', p));
      break;
    case 'punch':
      state.opacity = Math.min(1, p * 3);
      uniform(state, 1 + Math.sin(p * Math.PI) * 0.35);
      break;
    case 'bounce': {
      state.opacity = Math.min(1, p * 3);
      const damping = remaining ** 2;
      state.offsetY = -Math.sin(p * Math.PI * 3) * animation.distance * 0.35 * damping;
      uniform(state, animation.scaleFrom + (1 - animation.scaleFrom) * applyEasing('easeOut', p));
      break;
    }
    case 'elastic':
      state.opacity = Math.min(1, p * 2);
      uniform(state, applyEasing('elastic', p));
      break;
    case 'slideUp':
      state.opacity = p;
      state.offsetY = remaining * animation.distance;
      break;
    case 'slideDown':
      state.opacity = p;
      state.offsetY = -remaining * animation.distance;
      break;
    case 'slideLeft':
      state.opacity = p;
      state.offsetX = remaining * animation.distance;
      break;
    case 'slideRight':
      state.opacity = p;
      state.offsetX = -remaining * animation.distance;
      break;
    case 'rotate':
      state.opacity = p;
      state.rotation = remaining * animation.rotation;
      uniform(state, animation.scaleFrom + (1 - animation.scaleFrom) * p);
      break;
    case 'flip':
      state.opacity = Math.min(1, p * 1.6);
      // Squashed to nothing at the start, opening out to full width.
      state.scaleX = Math.max(0.02, Math.abs(Math.sin(p * (Math.PI / 2))));
      state.scaleY = 1;
      break;
    case 'blur':
      state.opacity = p;
      state.blur = remaining * animation.blurFrom;
      break;
    case 'shake':
      state.opacity = Math.min(1, p * 3);
      state.offsetX = Math.sin(p * Math.PI * 6) * animation.distance * 0.12 * remaining;
      break;
    case 'glow':
      state.opacity = p;
      uniform(state, animation.scaleFrom + (1 - animation.scaleFrom) * p);
      break;
    default:
      state.opacity = p;
  }

  return state;
}

/** Words of a cue that should be on screen at `time`, given the reveal mode. */
export function visibleWordIndices(
  cue: CaptionCue,
  time: number,
  style: CaptionStyle,
): number[] {
  const active = activeWordIndex(cue, time);
  if (style.reveal === 'all' || style.reveal === 'karaoke') {
    return cue.words.map((_, index) => index);
  }
  if (active < 0) return [];
  const visible = Math.max(1, Math.round(style.visibleWords));
  const first = Math.max(0, active - visible + 1);
  const out: number[] = [];
  for (let i = first; i <= active; i += 1) out.push(i);
  return out;
}

/**
 * Builds the project drawn for one caption frame.
 *
 * Returns null when nothing should be on screen, so the caller can skip the
 * render entirely rather than compositing an empty layer.
 */
export function buildCaptionProject(options: CaptionFrameOptions): {
  project: Project;
  boxes: Array<{ box: WordBox; state: WordState; x: number; y: number }>;
} | null {
  const { track, style, animation, width, height, time } = options;
  const cue = cueAt(track, time);
  if (!cue || cue.words.length === 0) return null;

  const typography = captionTypography(style, height, width);
  const active = activeWordIndex(cue, time);
  const visibleIndices = visibleWordIndices(cue, time, style);
  if (visibleIndices.length === 0) return null;

  // In word-by-word mode only a slice of the line is on screen, and that slice
  // is what has to be centred: laying it out inside the full cue would leave a
  // single word sitting off-centre, at a height that shifts with the length of
  // the words around it.
  const laidOut =
    style.reveal === 'wordByWord'
      ? { ...cue, words: visibleIndices.map((index) => cue.words[index]!) }
      : cue;

  const { layout, boxes } = measureWords(laidOut, typography);
  if (boxes.length === 0) return null;

  // Box indices are positions within `laidOut`; map them back to the cue.
  const indexInCue = (boxIndex: number): number =>
    style.reveal === 'wordByWord' ? (visibleIndices[boxIndex] ?? boxIndex) : boxIndex;

  const visible = new Set(
    style.reveal === 'wordByWord' ? boxes.map((box) => box.index) : visibleIndices,
  );

  // Vertical placement of the caption block, as a fraction of the frame.
  // 0.74 keeps a bottom caption above the band the platforms cover with their
  // own interface, without pushing it into the middle of the frame.
  const anchorY =
    style.position === 'top' ? 0.16 : style.position === 'center' ? 0.5 : 0.74;
  const blockCenterX = width * (0.5 + style.offsetXRatio);
  const blockCenterY = height * anchorY + height * style.offsetYRatio;

  const project = createProject('caption');
  project.canvas.width = width;
  project.canvas.height = height;
  project.layers = [];

  const placed: Array<{ box: WordBox; state: WordState; x: number; y: number }> = [];

  boxes.forEach((box) => {
    if (!visible.has(box.index)) return;

    const cueIndex = indexInCue(box.index);
    const isActive = cueIndex === active;
    const isFuture = cueIndex > active;

    // Timing is anchored to the audio: a word animates in when it is spoken.
    // Only when the whole line appears at once does the stagger drive the order,
    // measured from the cue's start.
    const startAt =
      style.reveal === 'all'
        ? cue.start + cueIndex * animation.wordStagger
        : box.word.start;
    const elapsed = time - startAt;
    const progress =
      animation.wordDuration <= 0 ? 1 : clamp(elapsed / animation.wordDuration, 0, 1);
    const state = wordState(animation.word, progress, animation);

    const layer = createTextLayer({ name: box.word.text });
    layer.text = box.word.text;
    layer.typography = { ...typography, maxWidth: null, align: 'center' };
    layer.style = cloneLayerStyle(style, {
      active: isActive && style.activeWord.enabled,
      emphasis: box.word.emphasis === true,
    });

    let emphasis = 1;
    if (isActive && style.activeWord.enabled) emphasis *= style.activeWord.scale;
    if (box.word.emphasis) emphasis *= style.emphasisScale;

    let opacity = state.opacity;
    if (style.reveal === 'karaoke' && isFuture) opacity *= style.upcomingOpacity;

    const x = blockCenterX + (box.centerX - layout.width / 2) + state.offsetX;
    const y = blockCenterY + (box.centerY - layout.height / 2) + state.offsetY;

    layer.transform = {
      ...layer.transform,
      // renderProject positions a layer relative to the canvas centre.
      x: x - width / 2,
      y: y - height / 2,
      scaleX: state.scaleX * emphasis,
      scaleY: state.scaleY * emphasis,
      rotation: state.rotation,
      anchorX: 0.5,
      anchorY: 0.5,
    };
    layer.opacity = clamp(opacity, 0, 1);

    project.layers.push(layer);
    placed.push({ box, state, x, y });
  });

  if (project.layers.length === 0) return null;
  project.activeLayerId = project.layers[0]!.id;
  return { project, boxes: placed };
}

/** Applies the active-word / upcoming / emphasis colour overrides. */
function cloneLayerStyle(
  style: CaptionStyle,
  flags: { active: boolean; emphasis: boolean },
): TextLayer['style'] {
  const base = style.layer;
  const layer: TextLayer['style'] = {
    fill: { ...base.fill },
    stroke: { ...base.stroke },
    extrusion: { ...base.extrusion },
    gloss: { ...base.gloss },
    shadow: { ...base.shadow },
    glow: { ...base.glow },
  };

  if (flags.active) {
    layer.fill.color = style.activeWord.color;
    layer.fill.color2 = style.activeWord.color;
    if (style.activeWord.glow) {
      layer.glow = { ...layer.glow, enabled: true, color: style.activeWord.color };
    }
  }
  if (flags.emphasis) {
    layer.fill.color = style.emphasisColor;
    layer.fill.color2 = style.emphasisColor;
  }
  return layer;
}

/**
 * Draws the caption overlay for `time` onto a transparent context.
 *
 * The context is left with alpha 0 everywhere the caption does not cover, which
 * is what lets the same output be piped to ffmpeg as an overlay and drawn over
 * the live video in the preview.
 */
export function renderCaptionFrame(
  ctx: CanvasRenderingContext2D,
  options: CaptionFrameOptions,
  quality: 'preview' | 'final' = 'preview',
): void {
  const { width, height } = options;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, width, height);

  const built = buildCaptionProject(options);
  if (!built) return;

  const { style } = options;

  // The rounded box behind the active word is a shape, not text, so it is drawn
  // directly — before the glyphs, and under them.
  if (style.activeWord.enabled && style.activeWord.box) {
    const cue = cueAt(options.track, options.time);
    const active = cue ? activeWordIndex(cue, options.time) : -1;
    for (const placed of built.boxes) {
      if (placed.box.word.id !== cue?.words[active]?.id) continue;
      const pad = style.activeWord.boxPadding;
      const w = placed.box.width * placed.state.scaleX * style.activeWord.scale + pad * 2;
      const h = placed.box.height * placed.state.scaleY * style.activeWord.scale + pad * 1.2;
      ctx.save();
      ctx.globalAlpha = clamp(style.activeWord.boxOpacity * placed.state.opacity, 0, 1);
      ctx.fillStyle = withAlpha(style.activeWord.boxColor, 1);
      roundedRect(ctx, placed.x - w / 2, placed.y - h / 2, w, h, style.activeWord.boxRadius);
      ctx.fill();
      ctx.restore();
    }
  }

  const surface = acquire(width, height);
  renderProject(surface.ctx, built.project, 0, { scale: 1, background: null, quality });
  ctx.drawImage(surface.canvas, 0, 0);
  release(surface);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
