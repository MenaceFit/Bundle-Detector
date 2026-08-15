import type { StylePreset } from '@/types';
import { createProject } from '@/project/defaults';
import { renderProject } from '@/engine/renderer';
import { createCanvas } from '@/engine/renderer/scratch';
import { createLogger } from '@/utils/logger';

const log = createLogger('presets');
const cache = new Map<string, string>();

const THUMB_WIDTH = 300;
const THUMB_HEIGHT = 104;

/**
 * Renders a preset preview with the real engine, so what the card shows is
 * exactly what applying it produces. Results are memoised per preset id and
 * invalidated by the caller when the preset is edited.
 */
export function presetThumbnail(preset: StylePreset): string {
  const cached = cache.get(preset.id);
  if (cached) return cached;

  try {
    const project = createProject();
    project.canvas.width = THUMB_WIDTH;
    project.canvas.height = THUMB_HEIGHT;

    const layer = project.layers[0]!;
    layer.text = 'Aa';
    layer.style = preset.style;
    Object.assign(layer.typography, preset.typography);
    layer.typography.fontSize = 62;
    layer.typography.letterSpacing = 2;

    const { canvas, ctx } = createCanvas(THUMB_WIDTH, THUMB_HEIGHT);
    renderProject(ctx, project, 0, { scale: 1, background: null, quality: 'preview' });
    const url = canvas.toDataURL('image/png');
    cache.set(preset.id, url);
    return url;
  } catch (error) {
    log.warn(`Aperçu impossible pour le preset « ${preset.name} »`, error);
    return '';
  }
}

export function invalidateThumbnail(presetId: string): void {
  cache.delete(presetId);
}
