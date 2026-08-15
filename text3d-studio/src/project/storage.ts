import { createLogger } from '@/utils/logger';

const log = createLogger('storage');

/**
 * Thin, failure-tolerant wrapper around localStorage. Presets, favourites and
 * the colour history live here — everything stays on the machine, and a full or
 * disabled storage degrades to "settings are not remembered" instead of an
 * exception in the middle of a render.
 */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    log.warn(`Lecture impossible pour « ${key} »`, error);
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    log.warn(`Écriture impossible pour « ${key} »`, error);
    return false;
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    log.warn(`Suppression impossible pour « ${key} »`, error);
  }
}

export const STORAGE_KEYS = {
  userPresets: 'text3d.presets.user',
  builtinFavorites: 'text3d.presets.favorites',
  colorHistory: 'text3d.colors.history',
  colorFavorites: 'text3d.colors.favorites',
  fontFavorites: 'text3d.fonts.favorites',
  fontRecent: 'text3d.fonts.recent',
  autosave: 'text3d.project.autosave',
  autosaveEnabled: 'text3d.project.autosaveEnabled',
} as const;
