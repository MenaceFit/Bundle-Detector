import {
  PROJECT_VERSION,
  type CanvasSettings,
  type ExportSettings,
  type LayerEffects,
  type LayerStyle,
  type PerLetterConfig,
  type Project,
  type TextLayer,
  type TimelineSettings,
  type Transform,
  type Typography,
} from '@/types';
import { generateId } from '@/utils/object';

/**
 * The default look, rebuilt parametrically from the reference artwork: heavy
 * yellow display type, pale outline, deep extrusion to the bottom right, soft
 * drop shadow and a warm halo.
 */
export const YELLOW_3D_STYLE: LayerStyle = {
  fill: {
    kind: 'glossy',
    color: '#FFE500',
    color2: '#FFC000',
    color3: '#FFFFFF',
    angle: 90,
    midpoint: 0.56,
    opacity: 1,
    brightness: 1,
    contrast: 1,
    saturation: 1,
  },
  stroke: {
    enabled: true,
    width: 8,
    color: '#FFF9B5',
    color2: '#FFE066',
    gradient: false,
    angle: 90,
    opacity: 1,
    join: 'round',
    align: 'outside',
  },
  extrusion: {
    enabled: true,
    depth: 18,
    dirX: 3,
    dirY: 5,
    steps: 22,
    color: '#E5B800',
    color2: '#7A5B00',
    gradient: true,
    opacity: 1,
    blur: 0,
  },
  gloss: {
    enabled: true,
    intensity: 0.6,
    position: 0.3,
    width: 0.34,
    opacity: 0.7,
    angle: 90,
    color: '#FFFFFF',
  },
  shadow: {
    enabled: true,
    x: 6,
    y: 16,
    blur: 28,
    spread: 2,
    opacity: 0.34,
    color: '#4A3A00',
  },
  glow: {
    enabled: true,
    color: '#FFF07A',
    intensity: 0.9,
    blur: 48,
    opacity: 0.32,
  },
};

export const DEFAULT_TYPOGRAPHY: Typography = {
  fontFamily: 'Arial Black',
  fontWeight: 900,
  fontStyle: 'normal',
  fontSize: 220,
  letterSpacing: 4,
  wordSpacing: 0,
  lineHeight: 1.05,
  align: 'center',
  maxWidth: null,
  horizontalScale: 1,
  verticalScale: 1,
  uppercase: true,
};

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  skewX: 0,
  skewY: 0,
  perspective: 0,
  anchorX: 0.5,
  anchorY: 0.5,
};

export const DEFAULT_EFFECTS: LayerEffects = {
  sweep: { enabled: false, speed: 0.5, width: 0.22, intensity: 0.65, angle: 20, color: '#FFFFFF' },
  colorCycle: { enabled: false, speed: 0.25, range: 360 },
  jitter: { enabled: false, amount: 3, speed: 12, seed: 1234 },
  wave: { enabled: false, amplitude: 18, frequency: 0.8, speed: 0.6 },
  chromatic: { enabled: false, amount: 4, angle: 0 },
  noise: { enabled: false, amount: 0.12 },
};

export const DEFAULT_PER_LETTER: PerLetterConfig = {
  enabled: false,
  animation: 'pop',
  delay: 0.08,
  duration: 0.6,
  startTime: 0,
  order: 'normal',
  easing: 'easeOut',
  seed: 4242,
  distance: 160,
  rotation: 45,
  scale: 0.4,
  blur: 14,
};

export const DEFAULT_TIMELINE: TimelineSettings = {
  duration: 3,
  fps: 60,
  loop: true,
};

export const DEFAULT_CANVAS: CanvasSettings = {
  width: 1200,
  height: 800,
  preview: {
    kind: 'checkerboard',
    customColor: '#1b1e26',
    showGrid: false,
    showGuides: false,
    showBounds: false,
    showCenter: false,
    gridSize: 50,
  },
};

export const DEFAULT_EXPORT: ExportSettings = {
  format: 'png',
  width: 2048,
  height: 2048,
  fps: 30,
  duration: null,
  transparent: true,
  backgroundColor: '#000000',
  quality: 'high',
  gifColors: 128,
  loop: true,
};

export function createTextLayer(overrides: Partial<TextLayer> = {}): TextLayer {
  return {
    id: generateId('layer'),
    kind: 'text',
    name: 'Texte',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'source-over',
    text: 'TEXTE',
    typography: { ...DEFAULT_TYPOGRAPHY },
    transform: { ...DEFAULT_TRANSFORM },
    style: structuredCloneStyle(YELLOW_3D_STYLE),
    effects: structuredCloneEffects(DEFAULT_EFFECTS),
    animation: { tracks: [], perLetter: { ...DEFAULT_PER_LETTER } },
    ...overrides,
  };
}

export function createProject(name = 'Nouveau projet'): Project {
  const layer = createTextLayer();
  const now = new Date().toISOString();
  return {
    version: PROJECT_VERSION,
    id: generateId('project'),
    name,
    createdAt: now,
    modifiedAt: now,
    canvas: { ...DEFAULT_CANVAS, preview: { ...DEFAULT_CANVAS.preview } },
    layers: [layer],
    activeLayerId: layer.id,
    timeline: { ...DEFAULT_TIMELINE },
    exportSettings: { ...DEFAULT_EXPORT },
  };
}

function structuredCloneStyle(style: LayerStyle): LayerStyle {
  return {
    fill: { ...style.fill },
    stroke: { ...style.stroke },
    extrusion: { ...style.extrusion },
    gloss: { ...style.gloss },
    shadow: { ...style.shadow },
    glow: { ...style.glow },
  };
}

function structuredCloneEffects(effects: LayerEffects): LayerEffects {
  return {
    sweep: { ...effects.sweep },
    colorCycle: { ...effects.colorCycle },
    jitter: { ...effects.jitter },
    wave: { ...effects.wave },
    chromatic: { ...effects.chromatic },
    noise: { ...effects.noise },
  };
}

export { structuredCloneStyle as cloneStyle, structuredCloneEffects as cloneEffects };
