import type {
  AnimationPresetDefinition,
  EasingKind,
  KeyframeValue,
  TextLayer,
  TimelineSettings,
  Track,
} from '@/types';
import { createKeyframe } from './keyframes';

interface Point {
  t: number;
  value: KeyframeValue;
  easing?: EasingKind;
}

interface BuildContext {
  layer: TextLayer;
  timeline: TimelineSettings;
  /** Where the generated animation starts, in seconds. */
  start: number;
  /** How long it lasts, in seconds. */
  length: number;
}

type Builder = (ctx: BuildContext) => Track[];

interface PresetImpl extends AnimationPresetDefinition {
  build: Builder;
}

function track(property: string, points: Point[], ctx: BuildContext): Track {
  return {
    property,
    keyframes: points.map((point) =>
      createKeyframe(ctx.start + point.t * ctx.length, point.value, point.easing ?? 'easeOut'),
    ),
  };
}

/** Loop presets span the whole timeline and must return to their first value. */
function loopTrack(property: string, points: Point[], ctx: BuildContext): Track {
  return {
    property,
    keyframes: points.map((point) =>
      createKeyframe(point.t * ctx.timeline.duration, point.value, point.easing ?? 'easeInOut'),
    ),
  };
}

const ENTRANCES: PresetImpl[] = [
  {
    id: 'fadeIn',
    name: 'Fade In',
    category: 'in',
    description: 'Apparition en fondu',
    build: (ctx) => [track('opacity', [{ t: 0, value: 0 }, { t: 1, value: ctx.layer.opacity }], ctx)],
  },
  {
    id: 'scaleIn',
    name: 'Scale In',
    category: 'in',
    description: 'Grossit depuis 70 %',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.6, value: ctx.layer.opacity }], ctx),
      track('transform.scaleX', [{ t: 0, value: 0.7 }, { t: 1, value: ctx.layer.transform.scaleX }], ctx),
      track('transform.scaleY', [{ t: 0, value: 0.7 }, { t: 1, value: ctx.layer.transform.scaleY }], ctx),
    ],
  },
  {
    id: 'zoomIn',
    name: 'Zoom In',
    category: 'in',
    description: 'Zoom depuis un très petit format',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.4, value: ctx.layer.opacity }], ctx),
      track('transform.scaleX', [{ t: 0, value: 0.05 }, { t: 1, value: ctx.layer.transform.scaleX }], ctx),
      track('transform.scaleY', [{ t: 0, value: 0.05 }, { t: 1, value: ctx.layer.transform.scaleY }], ctx),
    ],
  },
  {
    id: 'slideUpIn',
    name: 'Slide Up',
    category: 'in',
    description: 'Monte depuis le bas',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.5, value: ctx.layer.opacity }], ctx),
      track(
        'transform.y',
        [{ t: 0, value: ctx.layer.transform.y + 260 }, { t: 1, value: ctx.layer.transform.y }],
        ctx,
      ),
    ],
  },
  {
    id: 'slideDownIn',
    name: 'Slide Down',
    category: 'in',
    description: 'Descend depuis le haut',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.5, value: ctx.layer.opacity }], ctx),
      track(
        'transform.y',
        [{ t: 0, value: ctx.layer.transform.y - 260 }, { t: 1, value: ctx.layer.transform.y }],
        ctx,
      ),
    ],
  },
  {
    id: 'slideLeftIn',
    name: 'Slide Left',
    category: 'in',
    description: 'Entre par la droite',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.5, value: ctx.layer.opacity }], ctx),
      track(
        'transform.x',
        [{ t: 0, value: ctx.layer.transform.x + 420 }, { t: 1, value: ctx.layer.transform.x }],
        ctx,
      ),
    ],
  },
  {
    id: 'slideRightIn',
    name: 'Slide Right',
    category: 'in',
    description: 'Entre par la gauche',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.5, value: ctx.layer.opacity }], ctx),
      track(
        'transform.x',
        [{ t: 0, value: ctx.layer.transform.x - 420 }, { t: 1, value: ctx.layer.transform.x }],
        ctx,
      ),
    ],
  },
  {
    id: 'pop',
    name: 'Pop',
    category: 'in',
    description: 'Rebond élastique à l’apparition',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.25, value: ctx.layer.opacity }], ctx),
      track(
        'transform.scaleX',
        [
          { t: 0, value: 0.4 },
          { t: 0.6, value: ctx.layer.transform.scaleX * 1.12, easing: 'easeOut' },
          { t: 1, value: ctx.layer.transform.scaleX, easing: 'easeInOut' },
        ],
        ctx,
      ),
      track(
        'transform.scaleY',
        [
          { t: 0, value: 0.4 },
          { t: 0.6, value: ctx.layer.transform.scaleY * 1.12, easing: 'easeOut' },
          { t: 1, value: ctx.layer.transform.scaleY, easing: 'easeInOut' },
        ],
        ctx,
      ),
    ],
  },
  {
    id: 'bounceIn',
    name: 'Bounce',
    category: 'in',
    description: 'Tombe et rebondit',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.2, value: ctx.layer.opacity }], ctx),
      track(
        'transform.y',
        [
          { t: 0, value: ctx.layer.transform.y - 340, easing: 'easeIn' },
          { t: 0.55, value: ctx.layer.transform.y, easing: 'easeOut' },
          { t: 0.75, value: ctx.layer.transform.y - 60, easing: 'easeIn' },
          { t: 0.88, value: ctx.layer.transform.y, easing: 'easeOut' },
          { t: 0.95, value: ctx.layer.transform.y - 18, easing: 'easeIn' },
          { t: 1, value: ctx.layer.transform.y },
        ],
        ctx,
      ),
    ],
  },
  {
    id: 'rotateIn',
    name: 'Rotate In',
    category: 'in',
    description: 'Pivote en apparaissant',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.5, value: ctx.layer.opacity }], ctx),
      track(
        'transform.rotation',
        [{ t: 0, value: ctx.layer.transform.rotation - 90 }, { t: 1, value: ctx.layer.transform.rotation }],
        ctx,
      ),
      track('transform.scaleX', [{ t: 0, value: 0.6 }, { t: 1, value: ctx.layer.transform.scaleX }], ctx),
      track('transform.scaleY', [{ t: 0, value: 0.6 }, { t: 1, value: ctx.layer.transform.scaleY }], ctx),
    ],
  },
];

const EXITS: PresetImpl[] = [
  {
    id: 'fadeOut',
    name: 'Fade Out',
    category: 'out',
    description: 'Disparition en fondu',
    build: (ctx) => [track('opacity', [{ t: 0, value: ctx.layer.opacity }, { t: 1, value: 0 }], ctx)],
  },
  {
    id: 'scaleOut',
    name: 'Scale Out',
    category: 'out',
    description: 'Rétrécit en disparaissant',
    build: (ctx) => [
      track('opacity', [{ t: 0.4, value: ctx.layer.opacity }, { t: 1, value: 0 }], ctx),
      track('transform.scaleX', [{ t: 0, value: ctx.layer.transform.scaleX }, { t: 1, value: 0.7 }], ctx),
      track('transform.scaleY', [{ t: 0, value: ctx.layer.transform.scaleY }, { t: 1, value: 0.7 }], ctx),
    ],
  },
  {
    id: 'zoomOut',
    name: 'Zoom Out',
    category: 'out',
    description: 'Explose vers l’extérieur',
    build: (ctx) => [
      track('opacity', [{ t: 0.5, value: ctx.layer.opacity }, { t: 1, value: 0 }], ctx),
      track('transform.scaleX', [{ t: 0, value: ctx.layer.transform.scaleX }, { t: 1, value: 2.4 }], ctx),
      track('transform.scaleY', [{ t: 0, value: ctx.layer.transform.scaleY }, { t: 1, value: 2.4 }], ctx),
    ],
  },
  {
    id: 'slideUpOut',
    name: 'Slide Up',
    category: 'out',
    description: 'Sort par le haut',
    build: (ctx) => [
      track('opacity', [{ t: 0.5, value: ctx.layer.opacity }, { t: 1, value: 0 }], ctx),
      track(
        'transform.y',
        [{ t: 0, value: ctx.layer.transform.y }, { t: 1, value: ctx.layer.transform.y - 300 }],
        ctx,
      ),
    ],
  },
  {
    id: 'slideDownOut',
    name: 'Slide Down',
    category: 'out',
    description: 'Sort par le bas',
    build: (ctx) => [
      track('opacity', [{ t: 0.5, value: ctx.layer.opacity }, { t: 1, value: 0 }], ctx),
      track(
        'transform.y',
        [{ t: 0, value: ctx.layer.transform.y }, { t: 1, value: ctx.layer.transform.y + 300 }],
        ctx,
      ),
    ],
  },
  {
    id: 'slideLeftOut',
    name: 'Slide Left',
    category: 'out',
    description: 'Sort par la gauche',
    build: (ctx) => [
      track('opacity', [{ t: 0.5, value: ctx.layer.opacity }, { t: 1, value: 0 }], ctx),
      track(
        'transform.x',
        [{ t: 0, value: ctx.layer.transform.x }, { t: 1, value: ctx.layer.transform.x - 460 }],
        ctx,
      ),
    ],
  },
  {
    id: 'slideRightOut',
    name: 'Slide Right',
    category: 'out',
    description: 'Sort par la droite',
    build: (ctx) => [
      track('opacity', [{ t: 0.5, value: ctx.layer.opacity }, { t: 1, value: 0 }], ctx),
      track(
        'transform.x',
        [{ t: 0, value: ctx.layer.transform.x }, { t: 1, value: ctx.layer.transform.x + 460 }],
        ctx,
      ),
    ],
  },
  {
    id: 'rotateOut',
    name: 'Rotate Out',
    category: 'out',
    description: 'Pivote en disparaissant',
    build: (ctx) => [
      track('opacity', [{ t: 0.4, value: ctx.layer.opacity }, { t: 1, value: 0 }], ctx),
      track(
        'transform.rotation',
        [{ t: 0, value: ctx.layer.transform.rotation }, { t: 1, value: ctx.layer.transform.rotation + 90 }],
        ctx,
      ),
    ],
  },
];

const LOOPS: PresetImpl[] = [
  {
    id: 'floating',
    name: 'Floating',
    category: 'loop',
    description: 'Flottement vertical continu',
    build: (ctx) => [
      loopTrack(
        'transform.y',
        [
          { t: 0, value: ctx.layer.transform.y },
          { t: 0.5, value: ctx.layer.transform.y - 28 },
          { t: 1, value: ctx.layer.transform.y },
        ],
        ctx,
      ),
    ],
  },
  {
    id: 'breathing',
    name: 'Breathing',
    category: 'loop',
    description: 'Respiration douce',
    build: (ctx) => [
      loopTrack(
        'transform.scaleX',
        [
          { t: 0, value: ctx.layer.transform.scaleX },
          { t: 0.5, value: ctx.layer.transform.scaleX * 1.05 },
          { t: 1, value: ctx.layer.transform.scaleX },
        ],
        ctx,
      ),
      loopTrack(
        'transform.scaleY',
        [
          { t: 0, value: ctx.layer.transform.scaleY },
          { t: 0.5, value: ctx.layer.transform.scaleY * 1.05 },
          { t: 1, value: ctx.layer.transform.scaleY },
        ],
        ctx,
      ),
    ],
  },
  {
    id: 'pulse',
    name: 'Pulse',
    category: 'loop',
    description: 'Pulsation d’opacité et d’échelle',
    build: (ctx) => [
      loopTrack(
        'opacity',
        [
          { t: 0, value: ctx.layer.opacity },
          { t: 0.5, value: ctx.layer.opacity * 0.55 },
          { t: 1, value: ctx.layer.opacity },
        ],
        ctx,
      ),
      loopTrack(
        'transform.scaleX',
        [
          { t: 0, value: ctx.layer.transform.scaleX },
          { t: 0.5, value: ctx.layer.transform.scaleX * 1.08 },
          { t: 1, value: ctx.layer.transform.scaleX },
        ],
        ctx,
      ),
      loopTrack(
        'transform.scaleY',
        [
          { t: 0, value: ctx.layer.transform.scaleY },
          { t: 0.5, value: ctx.layer.transform.scaleY * 1.08 },
          { t: 1, value: ctx.layer.transform.scaleY },
        ],
        ctx,
      ),
    ],
  },
  {
    id: 'shake',
    name: 'Shake',
    category: 'loop',
    description: 'Tremblement horizontal',
    build: (ctx) => {
      const base = ctx.layer.transform.x;
      const steps = 8;
      const points: Point[] = [];
      for (let i = 0; i <= steps; i += 1) {
        const amplitude = i === 0 || i === steps ? 0 : i % 2 === 0 ? -14 : 14;
        points.push({ t: i / steps, value: base + amplitude, easing: 'linear' });
      }
      return [loopTrack('transform.x', points, ctx)];
    },
  },
  {
    id: 'swing',
    name: 'Swing',
    category: 'loop',
    description: 'Balancement pendulaire',
    build: (ctx) => {
      const base = ctx.layer.transform.rotation;
      return [
        loopTrack(
          'transform.rotation',
          [
            { t: 0, value: base },
            { t: 0.25, value: base - 7 },
            { t: 0.75, value: base + 7 },
            { t: 1, value: base },
          ],
          ctx,
        ),
      ];
    },
  },
  {
    id: 'rotateLoop',
    name: 'Rotate',
    category: 'loop',
    description: 'Rotation complète continue',
    build: (ctx) => [
      loopTrack(
        'transform.rotation',
        [
          { t: 0, value: ctx.layer.transform.rotation, easing: 'linear' },
          { t: 1, value: ctx.layer.transform.rotation + 360, easing: 'linear' },
        ],
        ctx,
      ),
    ],
  },
  {
    id: 'glowPulse',
    name: 'Glow Pulse',
    category: 'loop',
    description: 'Halo qui respire',
    build: (ctx) => {
      const base = Math.max(0.4, ctx.layer.style.glow.intensity);
      return [
        loopTrack(
          'style.glow.intensity',
          [
            { t: 0, value: base * 0.45 },
            { t: 0.5, value: base * 1.6 },
            { t: 1, value: base * 0.45 },
          ],
          ctx,
        ),
      ];
    },
  },
];

const THREE_D: PresetImpl[] = [
  {
    id: 'rotation3d',
    name: '3D Rotation',
    category: '3d',
    description: 'Rotation avec perspective',
    build: (ctx) => [
      loopTrack(
        'transform.perspective',
        [
          { t: 0, value: -0.45 },
          { t: 0.5, value: 0.45 },
          { t: 1, value: -0.45 },
        ],
        ctx,
      ),
      loopTrack(
        'transform.skewX',
        [
          { t: 0, value: -10 },
          { t: 0.5, value: 10 },
          { t: 1, value: -10 },
        ],
        ctx,
      ),
    ],
  },
  {
    id: 'flip3d',
    name: '3D Flip',
    category: '3d',
    description: 'Retournement sur l’axe vertical',
    build: (ctx) => [
      track(
        'transform.scaleX',
        [
          { t: 0, value: 0.02, easing: 'easeOut' },
          { t: 0.55, value: ctx.layer.transform.scaleX * 1.06, easing: 'easeInOut' },
          { t: 1, value: ctx.layer.transform.scaleX },
        ],
        ctx,
      ),
      track('opacity', [{ t: 0, value: 0 }, { t: 0.3, value: ctx.layer.opacity }], ctx),
    ],
  },
  {
    id: 'depthReveal',
    name: 'Depth Reveal',
    category: '3d',
    description: 'La profondeur se construit progressivement',
    build: (ctx) => [
      track('opacity', [{ t: 0, value: 0 }, { t: 0.35, value: ctx.layer.opacity }], ctx),
      track(
        'style.extrusion.depth',
        [{ t: 0, value: 0 }, { t: 1, value: ctx.layer.style.extrusion.depth }],
        ctx,
      ),
      track('transform.scaleX', [{ t: 0, value: 0.7 }, { t: 1, value: ctx.layer.transform.scaleX }], ctx),
      track('transform.scaleY', [{ t: 0, value: 0.7 }, { t: 1, value: ctx.layer.transform.scaleY }], ctx),
    ],
  },
  {
    id: 'extrusionGrow',
    name: 'Extrusion Grow',
    category: '3d',
    description: 'L’extrusion sort du plat',
    build: (ctx) => [
      track(
        'style.extrusion.depth',
        [{ t: 0, value: 0 }, { t: 1, value: Math.max(8, ctx.layer.style.extrusion.depth) }],
        ctx,
      ),
    ],
  },
  {
    id: 'extrusionShrink',
    name: 'Extrusion Shrink',
    category: '3d',
    description: 'L’extrusion s’aplatit',
    build: (ctx) => [
      track(
        'style.extrusion.depth',
        [{ t: 0, value: Math.max(8, ctx.layer.style.extrusion.depth) }, { t: 1, value: 0 }],
        ctx,
      ),
    ],
  },
  {
    id: 'perspectiveZoom',
    name: 'Perspective Zoom',
    category: '3d',
    description: 'Zoom avec déformation de perspective',
    build: (ctx) => [
      track('transform.perspective', [{ t: 0, value: 0.85 }, { t: 1, value: ctx.layer.transform.perspective }], ctx),
      track('transform.scaleX', [{ t: 0, value: 0.35 }, { t: 1, value: ctx.layer.transform.scaleX }], ctx),
      track('transform.scaleY', [{ t: 0, value: 0.35 }, { t: 1, value: ctx.layer.transform.scaleY }], ctx),
      track('opacity', [{ t: 0, value: 0 }, { t: 0.4, value: ctx.layer.opacity }], ctx),
    ],
  },
  {
    id: 'tilt',
    name: 'Tilt',
    category: '3d',
    description: 'Inclinaison lente aller-retour',
    build: (ctx) => [
      loopTrack(
        'transform.skewY',
        [
          { t: 0, value: -6 },
          { t: 0.5, value: 6 },
          { t: 1, value: -6 },
        ],
        ctx,
      ),
      loopTrack(
        'transform.perspective',
        [
          { t: 0, value: -0.2 },
          { t: 0.5, value: 0.2 },
          { t: 1, value: -0.2 },
        ],
        ctx,
      ),
    ],
  },
  {
    id: 'wave3d',
    name: 'Wave',
    category: '3d',
    description: 'Ondulation de la profondeur',
    build: (ctx) => {
      const depth = Math.max(8, ctx.layer.style.extrusion.depth);
      return [
        loopTrack(
          'style.extrusion.depth',
          [
            { t: 0, value: depth * 0.4 },
            { t: 0.5, value: depth * 1.4 },
            { t: 1, value: depth * 0.4 },
          ],
          ctx,
        ),
        loopTrack(
          'style.extrusion.dirY',
          [
            { t: 0, value: ctx.layer.style.extrusion.dirY },
            { t: 0.5, value: -ctx.layer.style.extrusion.dirY },
            { t: 1, value: ctx.layer.style.extrusion.dirY },
          ],
          ctx,
        ),
      ];
    },
  },
];

export const ANIMATION_PRESETS: PresetImpl[] = [...ENTRANCES, ...EXITS, ...LOOPS, ...THREE_D];

export const ANIMATION_PRESET_LIST: AnimationPresetDefinition[] = ANIMATION_PRESETS.map(
  ({ id, name, category, description }) => ({ id, name, category, description }),
);

export function getAnimationPreset(id: string): PresetImpl | undefined {
  return ANIMATION_PRESETS.find((preset) => preset.id === id);
}

/**
 * Builds the tracks for a preset. Entrances start at 0, exits land on the last
 * frame, loops and 3D cycles span the whole timeline.
 */
export function buildPresetTracks(
  presetId: string,
  layer: TextLayer,
  timeline: TimelineSettings,
): Track[] {
  const preset = getAnimationPreset(presetId);
  if (!preset) return [];

  const length = Math.min(0.9, Math.max(0.25, timeline.duration * 0.35));
  const start =
    preset.category === 'out' ? Math.max(0, timeline.duration - length) : 0;

  return preset.build({ layer, timeline, start, length });
}

/** Merges generated tracks into existing ones, replacing same-property tracks. */
export function mergeTracks(existing: Track[], incoming: Track[]): Track[] {
  const byProperty = new Map(existing.map((t) => [t.property, t]));
  for (const track of incoming) {
    byProperty.set(track.property, track);
  }
  return [...byProperty.values()];
}
