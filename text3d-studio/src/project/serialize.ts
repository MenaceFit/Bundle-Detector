import {
  PROJECT_VERSION,
  type LayerEffects,
  type LayerStyle,
  type Project,
  type TextLayer,
} from '@/types';
import {
  createProject,
  createTextLayer,
  DEFAULT_CANVAS,
  DEFAULT_EFFECTS,
  DEFAULT_EXPORT,
  DEFAULT_PER_LETTER,
  DEFAULT_TIMELINE,
  DEFAULT_TRANSFORM,
  DEFAULT_TYPOGRAPHY,
  YELLOW_3D_STYLE,
} from './defaults';
import { sortKeyframes } from '@/animation/keyframes';
import { generateId } from '@/utils/object';

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

export function serializeProject(project: Project): string {
  const payload: Project = { ...project, modifiedAt: new Date().toISOString() };
  return JSON.stringify(payload, null, 2);
}

/**
 * Parses a `.project.json` file.
 *
 * Every field is merged over the current defaults, so a project saved by an
 * older build (or hand-edited) opens instead of crashing: unknown keys are
 * dropped, missing keys fall back, and out-of-range numbers are clamped by the
 * UI controls afterwards.
 */
export function deserializeProject(content: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new ProjectFormatError('Fichier illisible : ce n’est pas du JSON valide.');
  }

  if (!isRecord(raw)) {
    throw new ProjectFormatError('Fichier de projet invalide.');
  }
  if (typeof raw['version'] !== 'number') {
    throw new ProjectFormatError('Fichier de projet invalide : version manquante.');
  }
  if (raw['version'] > PROJECT_VERSION) {
    throw new ProjectFormatError(
      `Ce projet a été créé avec une version plus récente (v${String(raw['version'])}).`,
    );
  }

  const fallback = createProject();
  const layersRaw = Array.isArray(raw['layers']) ? raw['layers'] : [];
  const layers = layersRaw.filter(isRecord).map(parseLayer);
  const safeLayers = layers.length > 0 ? layers : [createTextLayer()];
  const activeId =
    typeof raw['activeLayerId'] === 'string' &&
    safeLayers.some((l) => l.id === raw['activeLayerId'])
      ? raw['activeLayerId']
      : safeLayers[0]!.id;

  const canvasRaw = isRecord(raw['canvas']) ? raw['canvas'] : {};
  const previewRaw = isRecord(canvasRaw['preview']) ? canvasRaw['preview'] : {};

  return {
    version: PROJECT_VERSION,
    id: typeof raw['id'] === 'string' ? raw['id'] : fallback.id,
    name: typeof raw['name'] === 'string' ? raw['name'] : 'Projet importé',
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : fallback.createdAt,
    modifiedAt: typeof raw['modifiedAt'] === 'string' ? raw['modifiedAt'] : fallback.modifiedAt,
    canvas: {
      width: numberOr(canvasRaw['width'], DEFAULT_CANVAS.width, 16, 16384),
      height: numberOr(canvasRaw['height'], DEFAULT_CANVAS.height, 16, 16384),
      preview: { ...DEFAULT_CANVAS.preview, ...pickKnown(previewRaw, DEFAULT_CANVAS.preview) },
    },
    layers: safeLayers,
    activeLayerId: activeId,
    timeline: {
      duration: numberOr(
        isRecord(raw['timeline']) ? raw['timeline']['duration'] : undefined,
        DEFAULT_TIMELINE.duration,
        0.1,
        600,
      ),
      fps: numberOr(
        isRecord(raw['timeline']) ? raw['timeline']['fps'] : undefined,
        DEFAULT_TIMELINE.fps,
        1,
        120,
      ),
      loop: booleanOr(isRecord(raw['timeline']) ? raw['timeline']['loop'] : undefined, true),
    },
    exportSettings: {
      ...DEFAULT_EXPORT,
      ...pickKnown(isRecord(raw['exportSettings']) ? raw['exportSettings'] : {}, DEFAULT_EXPORT),
    },
  };
}

function parseLayer(raw: Record<string, unknown>): TextLayer {
  const base = createTextLayer();
  const styleRaw = isRecord(raw['style']) ? raw['style'] : {};
  const effectsRaw = isRecord(raw['effects']) ? raw['effects'] : {};
  const animationRaw = isRecord(raw['animation']) ? raw['animation'] : {};

  return {
    id: typeof raw['id'] === 'string' ? raw['id'] : base.id,
    kind: 'text',
    name: typeof raw['name'] === 'string' ? raw['name'] : base.name,
    visible: booleanOr(raw['visible'], true),
    locked: booleanOr(raw['locked'], false),
    opacity: numberOr(raw['opacity'], 1, 0, 1),
    blendMode: isBlendMode(raw['blendMode']) ? raw['blendMode'] : 'source-over',
    text: typeof raw['text'] === 'string' ? raw['text'] : base.text,
    typography: {
      ...DEFAULT_TYPOGRAPHY,
      ...pickKnown(isRecord(raw['typography']) ? raw['typography'] : {}, DEFAULT_TYPOGRAPHY),
    },
    transform: {
      ...DEFAULT_TRANSFORM,
      ...pickKnown(isRecord(raw['transform']) ? raw['transform'] : {}, DEFAULT_TRANSFORM),
    },
    style: parseStyle(styleRaw),
    effects: parseEffects(effectsRaw),
    animation: {
      tracks: Array.isArray(animationRaw['tracks'])
        ? animationRaw['tracks'].filter(isRecord).flatMap(parseTrack)
        : [],
      perLetter: {
        ...DEFAULT_PER_LETTER,
        ...pickKnown(
          isRecord(animationRaw['perLetter']) ? animationRaw['perLetter'] : {},
          DEFAULT_PER_LETTER,
        ),
      },
    },
  };
}

function parseStyle(raw: Record<string, unknown>): LayerStyle {
  const merge = <K extends keyof LayerStyle>(key: K): LayerStyle[K] => ({
    ...YELLOW_3D_STYLE[key],
    ...pickKnown(isRecord(raw[key]) ? (raw[key] as Record<string, unknown>) : {}, YELLOW_3D_STYLE[key]),
  });
  return {
    fill: merge('fill'),
    stroke: merge('stroke'),
    extrusion: merge('extrusion'),
    gloss: merge('gloss'),
    shadow: merge('shadow'),
    glow: merge('glow'),
  };
}

function parseEffects(raw: Record<string, unknown>): LayerEffects {
  const merge = <K extends keyof LayerEffects>(key: K): LayerEffects[K] => ({
    ...DEFAULT_EFFECTS[key],
    ...pickKnown(isRecord(raw[key]) ? (raw[key] as Record<string, unknown>) : {}, DEFAULT_EFFECTS[key]),
  });
  return {
    sweep: merge('sweep'),
    colorCycle: merge('colorCycle'),
    jitter: merge('jitter'),
    wave: merge('wave'),
    chromatic: merge('chromatic'),
    noise: merge('noise'),
  };
}

function parseTrack(raw: Record<string, unknown>) {
  if (typeof raw['property'] !== 'string') return [];
  const keyframesRaw = Array.isArray(raw['keyframes']) ? raw['keyframes'] : [];
  const keyframes = keyframesRaw.filter(isRecord).flatMap((kf) => {
    const value = kf['value'];
    if (typeof value !== 'number' && typeof value !== 'string') return [];
    return [
      {
        id: typeof kf['id'] === 'string' ? kf['id'] : generateId('kf'),
        time: numberOr(kf['time'], 0, 0, 3600),
        value,
        easing: typeof kf['easing'] === 'string' ? (kf['easing'] as never) : ('easeInOut' as never),
        ...(Array.isArray(kf['bezier']) && kf['bezier'].length === 4
          ? { bezier: kf['bezier'].map(Number) as [number, number, number, number] }
          : {}),
      },
    ];
  });
  return [{ property: raw['property'], keyframes: sortKeyframes(keyframes) }];
}

/** Keeps only the keys the reference object declares, with matching types. */
function pickKnown<T extends object>(raw: Record<string, unknown>, reference: T): Partial<T> {
  const out: Record<string, unknown> = {};
  const source = reference as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const value = raw[key];
    if (value === undefined) continue;
    const expected = source[key];
    if (expected === null) {
      if (value === null || typeof value === 'number') out[key] = value;
      continue;
    }
    if (typeof value === typeof expected) out[key] = value;
  }
  return out as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const BLEND_MODES = new Set<string>([
  'source-over',
  'multiply',
  'screen',
  'overlay',
  'lighten',
  'darken',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'lighter',
]);

function isBlendMode(value: unknown): value is GlobalCompositeOperation {
  return typeof value === 'string' && BLEND_MODES.has(value);
}
