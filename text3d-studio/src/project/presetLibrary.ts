import type { LayerStyle, StylePreset, TextLayer } from '@/types';
import { BUILTIN_STYLE_PRESETS } from './stylePresets';
import { cloneEffects, cloneStyle } from './defaults';
import { readJson, STORAGE_KEYS, writeJson } from './storage';
import { generateId } from '@/utils/object';

/** Built-ins are code; user presets and favourite flags live in localStorage. */
export function loadPresets(): StylePreset[] {
  const favorites = new Set(readJson<string[]>(STORAGE_KEYS.builtinFavorites, ['3d-yellow']));
  const builtins = BUILTIN_STYLE_PRESETS.map((preset) => ({
    ...preset,
    style: cloneStyle(preset.style),
    favorite: favorites.has(preset.id),
  }));
  const user = readJson<StylePreset[]>(STORAGE_KEYS.userPresets, []).filter(isPreset);
  return [...builtins, ...user];
}

export function saveUserPresets(presets: StylePreset[]): boolean {
  return writeJson(
    STORAGE_KEYS.userPresets,
    presets.filter((preset) => !preset.builtin),
  );
}

export function saveBuiltinFavorites(presets: StylePreset[]): void {
  writeJson(
    STORAGE_KEYS.builtinFavorites,
    presets.filter((preset) => preset.builtin && preset.favorite).map((preset) => preset.id),
  );
}

/** Captures the visual identity of a layer, without its text or animation. */
export function presetFromLayer(layer: TextLayer, name: string): StylePreset {
  return {
    id: generateId('preset'),
    name,
    builtin: false,
    favorite: false,
    typography: {
      fontFamily: layer.typography.fontFamily,
      fontWeight: layer.typography.fontWeight,
      letterSpacing: layer.typography.letterSpacing,
      lineHeight: layer.typography.lineHeight,
      uppercase: layer.typography.uppercase,
    },
    style: cloneStyle(layer.style),
    effects: cloneEffects(layer.effects),
  };
}

export function serializePreset(preset: StylePreset): string {
  return JSON.stringify({ ...preset, builtin: false }, null, 2);
}

export function deserializePreset(content: string): StylePreset {
  const parsed: unknown = JSON.parse(content);
  if (!isPreset(parsed)) {
    throw new Error('Ce fichier n’est pas un preset valide.');
  }
  return { ...parsed, id: generateId('preset'), builtin: false };
}

export function duplicatePreset(preset: StylePreset): StylePreset {
  return {
    ...preset,
    id: generateId('preset'),
    name: `${preset.name} (copie)`,
    builtin: false,
    style: cloneStyle(preset.style),
  };
}

function isPreset(value: unknown): value is StylePreset {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StylePreset>;
  if (typeof candidate.name !== 'string') return false;
  const style = candidate.style as Partial<LayerStyle> | undefined;
  if (!style || typeof style !== 'object') return false;
  return ['fill', 'stroke', 'extrusion', 'gloss', 'shadow', 'glow'].every(
    (key) => typeof (style as Record<string, unknown>)[key] === 'object',
  );
}
