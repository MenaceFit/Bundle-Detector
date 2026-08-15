/**
 * Registry of animatable properties.
 *
 * A track is bound to a property by its dotted path on the layer, so adding a
 * new animatable knob is a one-line change here — the timeline, the keyframe
 * buttons and the evaluator all read from this table.
 */

export type PropertyType = 'number' | 'color';

export interface PropertyDescriptor {
  path: string;
  label: string;
  group: string;
  type: PropertyType;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export const ANIMATABLE_PROPERTIES: PropertyDescriptor[] = [
  { path: 'opacity', label: 'Opacité', group: 'Calque', type: 'number', min: 0, max: 1, step: 0.01 },

  { path: 'transform.x', label: 'Position X', group: 'Transform', type: 'number', step: 1, unit: 'px' },
  { path: 'transform.y', label: 'Position Y', group: 'Transform', type: 'number', step: 1, unit: 'px' },
  { path: 'transform.scaleX', label: 'Scale X', group: 'Transform', type: 'number', min: 0, max: 5, step: 0.01 },
  { path: 'transform.scaleY', label: 'Scale Y', group: 'Transform', type: 'number', min: 0, max: 5, step: 0.01 },
  { path: 'transform.rotation', label: 'Rotation', group: 'Transform', type: 'number', step: 1, unit: '°' },
  { path: 'transform.skewX', label: 'Skew X', group: 'Transform', type: 'number', min: -60, max: 60, step: 0.5, unit: '°' },
  { path: 'transform.skewY', label: 'Skew Y', group: 'Transform', type: 'number', min: -60, max: 60, step: 0.5, unit: '°' },
  { path: 'transform.perspective', label: 'Perspective', group: 'Transform', type: 'number', min: -1, max: 1, step: 0.01 },

  { path: 'typography.fontSize', label: 'Taille', group: 'Typographie', type: 'number', min: 1, max: 1200, step: 1, unit: 'px' },
  { path: 'typography.letterSpacing', label: 'Letter spacing', group: 'Typographie', type: 'number', min: -100, max: 300, step: 0.5, unit: 'px' },
  { path: 'typography.wordSpacing', label: 'Word spacing', group: 'Typographie', type: 'number', min: -100, max: 300, step: 0.5, unit: 'px' },
  { path: 'typography.lineHeight', label: 'Interligne', group: 'Typographie', type: 'number', min: 0.4, max: 3, step: 0.01 },
  { path: 'typography.horizontalScale', label: 'Échelle H', group: 'Typographie', type: 'number', min: 0.2, max: 3, step: 0.01 },
  { path: 'typography.verticalScale', label: 'Échelle V', group: 'Typographie', type: 'number', min: 0.2, max: 3, step: 0.01 },

  { path: 'style.fill.color', label: 'Couleur face', group: 'Remplissage', type: 'color' },
  { path: 'style.fill.color2', label: 'Couleur 2', group: 'Remplissage', type: 'color' },
  { path: 'style.fill.opacity', label: 'Opacité face', group: 'Remplissage', type: 'number', min: 0, max: 1, step: 0.01 },
  { path: 'style.fill.angle', label: 'Angle dégradé', group: 'Remplissage', type: 'number', step: 1, unit: '°' },
  { path: 'style.fill.brightness', label: 'Luminosité', group: 'Remplissage', type: 'number', min: 0, max: 3, step: 0.01 },
  { path: 'style.fill.saturation', label: 'Saturation', group: 'Remplissage', type: 'number', min: 0, max: 3, step: 0.01 },

  { path: 'style.stroke.width', label: 'Épaisseur contour', group: 'Contour', type: 'number', min: 0, max: 120, step: 0.5, unit: 'px' },
  { path: 'style.stroke.color', label: 'Couleur contour', group: 'Contour', type: 'color' },
  { path: 'style.stroke.opacity', label: 'Opacité contour', group: 'Contour', type: 'number', min: 0, max: 1, step: 0.01 },

  { path: 'style.extrusion.depth', label: 'Profondeur', group: 'Extrusion', type: 'number', min: 0, max: 300, step: 1, unit: 'px' },
  { path: 'style.extrusion.dirX', label: 'Direction X', group: 'Extrusion', type: 'number', min: -10, max: 10, step: 0.1 },
  { path: 'style.extrusion.dirY', label: 'Direction Y', group: 'Extrusion', type: 'number', min: -10, max: 10, step: 0.1 },
  { path: 'style.extrusion.color', label: 'Couleur extrusion', group: 'Extrusion', type: 'color' },
  { path: 'style.extrusion.opacity', label: 'Opacité extrusion', group: 'Extrusion', type: 'number', min: 0, max: 1, step: 0.01 },
  { path: 'style.extrusion.blur', label: 'Flou extrusion', group: 'Extrusion', type: 'number', min: 0, max: 40, step: 0.5, unit: 'px' },

  { path: 'style.gloss.intensity', label: 'Intensité gloss', group: 'Brillance', type: 'number', min: 0, max: 2, step: 0.01 },
  { path: 'style.gloss.position', label: 'Position gloss', group: 'Brillance', type: 'number', min: -0.5, max: 1.5, step: 0.01 },
  { path: 'style.gloss.width', label: 'Largeur gloss', group: 'Brillance', type: 'number', min: 0.01, max: 1, step: 0.01 },
  { path: 'style.gloss.angle', label: 'Angle gloss', group: 'Brillance', type: 'number', step: 1, unit: '°' },
  { path: 'style.gloss.opacity', label: 'Opacité gloss', group: 'Brillance', type: 'number', min: 0, max: 1, step: 0.01 },

  { path: 'style.shadow.x', label: 'Ombre X', group: 'Ombre', type: 'number', step: 1, unit: 'px' },
  { path: 'style.shadow.y', label: 'Ombre Y', group: 'Ombre', type: 'number', step: 1, unit: 'px' },
  { path: 'style.shadow.blur', label: 'Flou ombre', group: 'Ombre', type: 'number', min: 0, max: 200, step: 1, unit: 'px' },
  { path: 'style.shadow.spread', label: 'Étalement ombre', group: 'Ombre', type: 'number', min: -50, max: 100, step: 1, unit: 'px' },
  { path: 'style.shadow.opacity', label: 'Opacité ombre', group: 'Ombre', type: 'number', min: 0, max: 1, step: 0.01 },
  { path: 'style.shadow.color', label: 'Couleur ombre', group: 'Ombre', type: 'color' },

  { path: 'style.glow.intensity', label: 'Intensité glow', group: 'Glow', type: 'number', min: 0, max: 4, step: 0.01 },
  { path: 'style.glow.blur', label: 'Flou glow', group: 'Glow', type: 'number', min: 0, max: 200, step: 1, unit: 'px' },
  { path: 'style.glow.opacity', label: 'Opacité glow', group: 'Glow', type: 'number', min: 0, max: 1, step: 0.01 },
  { path: 'style.glow.color', label: 'Couleur glow', group: 'Glow', type: 'color' },
];

const BY_PATH = new Map(ANIMATABLE_PROPERTIES.map((p) => [p.path, p]));

export function getProperty(path: string): PropertyDescriptor | undefined {
  return BY_PATH.get(path);
}

export function propertyLabel(path: string): string {
  return BY_PATH.get(path)?.label ?? path;
}
