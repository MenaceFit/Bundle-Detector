/**
 * Domain model for Text3D Studio.
 *
 * Everything the renderer, the animation engine and the exporters need lives in
 * a single serialisable `Project` tree — no bitmaps, no derived caches. Saving a
 * project is `JSON.stringify(project)`, and reopening it reproduces the render
 * bit for bit.
 */

export type Hex = string;

/* ------------------------------------------------------------------ styles */

export type FillKind = 'solid' | 'linear' | 'radial' | 'glossy' | 'metallic';

export interface FillStyle {
  kind: FillKind;
  color: Hex;
  color2: Hex;
  color3: Hex;
  /** Gradient direction in degrees (0 = left→right, 90 = top→bottom). */
  angle: number;
  /** Position of the middle stop, 0..1. */
  midpoint: number;
  opacity: number;
  brightness: number;
  contrast: number;
  saturation: number;
}

export type StrokeJoin = 'round' | 'miter' | 'bevel';
export type StrokeAlign = 'outside' | 'center';

export interface StrokeStyle {
  enabled: boolean;
  width: number;
  color: Hex;
  color2: Hex;
  gradient: boolean;
  angle: number;
  opacity: number;
  join: StrokeJoin;
  align: StrokeAlign;
}

export interface ExtrusionStyle {
  enabled: boolean;
  depth: number;
  /** Direction vector of the extrusion in canvas units (not normalised). */
  dirX: number;
  dirY: number;
  /** Number of stacked copies used to fake the extruded side. */
  steps: number;
  color: Hex;
  color2: Hex;
  gradient: boolean;
  opacity: number;
  blur: number;
}

export interface GlossStyle {
  enabled: boolean;
  intensity: number;
  /** Vertical placement of the highlight band, 0 (top) .. 1 (bottom). */
  position: number;
  width: number;
  opacity: number;
  angle: number;
  color: Hex;
}

export interface ShadowStyle {
  enabled: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  opacity: number;
  color: Hex;
}

export interface GlowStyle {
  enabled: boolean;
  color: Hex;
  intensity: number;
  blur: number;
  opacity: number;
}

export interface LayerStyle {
  fill: FillStyle;
  stroke: StrokeStyle;
  extrusion: ExtrusionStyle;
  gloss: GlossStyle;
  shadow: ShadowStyle;
  glow: GlowStyle;
}

/* -------------------------------------------------------------- typography */

export type HAlign = 'left' | 'center' | 'right';

export interface Typography {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fontSize: number;
  letterSpacing: number;
  wordSpacing: number;
  /** Multiplier applied to fontSize to get the baseline advance. */
  lineHeight: number;
  align: HAlign;
  /** Wrap width in canvas units, or null for no automatic wrapping. */
  maxWidth: number | null;
  horizontalScale: number;
  verticalScale: number;
  uppercase: boolean;
}

/* --------------------------------------------------------------- transform */

export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
  /** Trapezoid warp strength, -1..1. Negative narrows the top. */
  perspective: number;
  /**
   * Anchor as a fraction of the text bounding box (0.5/0.5 = centre). It is
   * both the pivot for rotation/scale and the point placed at `x`/`y`, so
   * `anchorY` doubles as the vertical alignment of the text block.
   */
  anchorX: number;
  anchorY: number;
}

/* ----------------------------------------------------------------- effects */

export interface SweepEffect {
  enabled: boolean;
  speed: number;
  width: number;
  intensity: number;
  angle: number;
  color: Hex;
}

export interface ColorCycleEffect {
  enabled: boolean;
  speed: number;
  /** Hue span swept over one cycle, in degrees. */
  range: number;
}

export interface JitterEffect {
  enabled: boolean;
  amount: number;
  speed: number;
  seed: number;
}

export interface WaveEffect {
  enabled: boolean;
  amplitude: number;
  frequency: number;
  speed: number;
}

export interface ChromaticEffect {
  enabled: boolean;
  amount: number;
  angle: number;
}

export interface NoiseEffect {
  enabled: boolean;
  amount: number;
}

export interface LayerEffects {
  sweep: SweepEffect;
  colorCycle: ColorCycleEffect;
  jitter: JitterEffect;
  wave: WaveEffect;
  chromatic: ChromaticEffect;
  noise: NoiseEffect;
}

/* --------------------------------------------------------------- animation */

export type EasingKind =
  | 'hold'
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'cubic'
  | 'back'
  | 'elastic'
  | 'bounce'
  | 'bezier';

export type KeyframeValue = number | string;

export interface Keyframe {
  id: string;
  /** Absolute time in seconds from the start of the timeline. */
  time: number;
  value: KeyframeValue;
  easing: EasingKind;
  /** Control points for `easing: 'bezier'`, as [x1, y1, x2, y2]. */
  bezier?: [number, number, number, number];
}

/** A track animates one property, addressed by its dotted path on the layer. */
export interface Track {
  property: string;
  keyframes: Keyframe[];
}

export type LetterAnimationKind =
  | 'fade'
  | 'scale'
  | 'rotate'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'bounce'
  | 'blur'
  | 'flip3d'
  | 'pop';

export type LetterOrder = 'normal' | 'reverse' | 'random' | 'center' | 'edges';

export interface PerLetterConfig {
  enabled: boolean;
  animation: LetterAnimationKind;
  /** Stagger between two consecutive characters, in seconds. */
  delay: number;
  duration: number;
  startTime: number;
  order: LetterOrder;
  easing: EasingKind;
  seed: number;
  distance: number;
  rotation: number;
  scale: number;
  blur: number;
}

export interface LayerAnimation {
  tracks: Track[];
  perLetter: PerLetterConfig;
}

/* ------------------------------------------------------------------ layers */

export type LayerKind = 'text';

export interface BaseLayer {
  id: string;
  kind: LayerKind;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: GlobalCompositeOperation;
}

export interface TextLayer extends BaseLayer {
  kind: 'text';
  text: string;
  typography: Typography;
  transform: Transform;
  style: LayerStyle;
  effects: LayerEffects;
  animation: LayerAnimation;
}

export type Layer = TextLayer;

/* ------------------------------------------------------------------ canvas */

export type PreviewBackgroundKind = 'checkerboard' | 'white' | 'black' | 'custom' | 'transparent';

export interface PreviewSettings {
  kind: PreviewBackgroundKind;
  customColor: Hex;
  showGrid: boolean;
  showGuides: boolean;
  showBounds: boolean;
  showCenter: boolean;
  gridSize: number;
}

export interface CanvasSettings {
  width: number;
  height: number;
  preview: PreviewSettings;
}

/* ---------------------------------------------------------------- timeline */

export interface TimelineSettings {
  duration: number;
  fps: number;
  loop: boolean;
}

/* ------------------------------------------------------------------ export */

export type ImageFormat = 'png' | 'webp';
export type AnimationFormat = 'webm' | 'gif' | 'sequence';
export type ExportFormat = ImageFormat | AnimationFormat;
export type ExportQuality = 'low' | 'medium' | 'high' | 'max';

export interface ExportSettings {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  /** Export duration in seconds; falls back to the timeline duration when null. */
  duration: number | null;
  transparent: boolean;
  backgroundColor: Hex;
  quality: ExportQuality;
  /** GIF palette size, 2..256. */
  gifColors: number;
  loop: boolean;
}

/* ----------------------------------------------------------------- project */

export const PROJECT_VERSION = 1;

export interface Project {
  version: number;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  canvas: CanvasSettings;
  layers: Layer[];
  activeLayerId: string;
  timeline: TimelineSettings;
  exportSettings: ExportSettings;
}

/* ----------------------------------------------------------------- presets */

/** A style preset stores only the visual layers of a text layer. */
export interface StylePreset {
  id: string;
  name: string;
  builtin: boolean;
  favorite: boolean;
  typography: Partial<Typography>;
  style: LayerStyle;
  effects?: Partial<LayerEffects>;
}

export interface AnimationPresetDefinition {
  id: string;
  name: string;
  category: 'in' | 'out' | 'loop' | '3d';
  description: string;
}
