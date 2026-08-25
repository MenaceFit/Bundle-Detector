import type { LayerStyle } from '@/types';
import { cloneStyle } from '@/project/defaults';
import type { ActiveWordStyle, CaptionAnimation, CaptionPreset, CaptionStyle } from './types';

/**
 * Caption presets.
 *
 * A caption's look is expressed with the *existing* `LayerStyle` of the 3D text
 * engine — fill, stroke, extrusion, gloss, shadow, glow. There is no second
 * graphics engine: a caption is a text layer the renderer already knows how to
 * draw, so every style the 3D workspace can produce is available here too.
 */

function flatStyle(overrides: Partial<LayerStyle> = {}): LayerStyle {
  const style = cloneStyle({
    fill: {
      kind: 'solid',
      color: '#FFFFFF',
      color2: '#DDDDDD',
      color3: '#FFFFFF',
      angle: 90,
      midpoint: 0.55,
      opacity: 1,
      brightness: 1,
      contrast: 1,
      saturation: 1,
    },
    stroke: {
      enabled: true,
      width: 9,
      color: '#000000',
      color2: '#000000',
      gradient: false,
      angle: 90,
      opacity: 1,
      join: 'round',
      align: 'outside',
    },
    extrusion: {
      enabled: false,
      depth: 0,
      dirX: 0,
      dirY: 4,
      steps: 12,
      color: '#000000',
      color2: '#000000',
      gradient: true,
      opacity: 1,
      blur: 0,
    },
    gloss: {
      enabled: false,
      intensity: 0.5,
      position: 0.3,
      width: 0.3,
      opacity: 0.6,
      angle: 90,
      color: '#FFFFFF',
    },
    shadow: {
      enabled: true,
      x: 0,
      y: 6,
      blur: 18,
      spread: 0,
      opacity: 0.55,
      color: '#000000',
    },
    glow: {
      enabled: false,
      color: '#FFFFFF',
      intensity: 1,
      blur: 30,
      opacity: 0.5,
    },
  });
  return { ...style, ...overrides };
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  layer: flatStyle(),
  fontFamily: 'Arial Black',
  fontWeight: 900,
  fontSizeRatio: 0.062,
  letterSpacing: 0,
  lineHeight: 1.15,
  uppercase: true,
  maxWidthRatio: 0.86,
  position: 'bottom',
  offsetYRatio: 0,
  offsetXRatio: 0,
  reveal: 'karaoke',
  visibleWords: 3,
  activeWord: {
    enabled: true,
    color: '#FFE500',
    scale: 1.12,
    glow: false,
    box: false,
    boxColor: '#FFE500',
    boxRadius: 14,
    boxPadding: 14,
    boxOpacity: 1,
  },
  upcomingColor: '#FFFFFF',
  upcomingOpacity: 1,
  emphasisColor: '#FFE500',
  emphasisScale: 1.1,
  emphasisItalic: false,
  wordTilt: 0,
};

export const DEFAULT_CAPTION_ANIMATION: CaptionAnimation = {
  word: 'pop',
  wordDuration: 0.22,
  wordStagger: 0.06,
  characterStagger: 0,
  distance: 60,
  rotation: 12,
  scaleFrom: 0.72,
  blurFrom: 8,
  cueFade: 0.08,
  activeMotion: 'none',
  activeMotionAmount: 1,
};

/** Overrides merge into the defaults, so a preset only states what it changes. */
type PresetOverrides = Omit<Partial<CaptionStyle>, 'layer' | 'activeWord'> & {
  layer?: Partial<LayerStyle>;
  activeWord?: Partial<ActiveWordStyle>;
};

function preset(
  id: string,
  name: string,
  category: CaptionPreset['category'],
  description: string,
  style: PresetOverrides,
  animation: Partial<CaptionAnimation> = {},
): CaptionPreset {
  const { layer, activeWord, ...rest } = style;
  return {
    id,
    name,
    category,
    description,
    builtin: true,
    style: {
      ...DEFAULT_CAPTION_STYLE,
      ...rest,
      layer: { ...cloneStyle(DEFAULT_CAPTION_STYLE.layer), ...(layer ?? {}) },
      activeWord: { ...DEFAULT_CAPTION_STYLE.activeWord, ...(activeWord ?? {}) },
    },
    animation: { ...DEFAULT_CAPTION_ANIMATION, ...animation },
  };
}

export const BUILTIN_CAPTION_PRESETS: CaptionPreset[] = [
  preset('classic', 'Classic', 'basic', 'Blanc, contour noir, une ligne à la fois', {
    reveal: 'all',
    activeWord: { enabled: false },
  }, { word: 'fade', wordStagger: 0 }),

  preset('minimal', 'Minimal', 'basic', 'Sobre, sans contour ni ombre marquée', {
    reveal: 'all',
    fontSizeRatio: 0.05,
    uppercase: false,
    activeWord: { enabled: false },
    layer: {
      stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 4 },
      shadow: { ...DEFAULT_CAPTION_STYLE.layer.shadow, opacity: 0.35, blur: 12 },
    },
  }, { word: 'fade', wordStagger: 0, wordDuration: 0.18 }),

  preset('bold', 'Bold', 'basic', 'Gros titre plein écran', {
    fontSizeRatio: 0.082,
    reveal: 'all',
    activeWord: { enabled: false },
    layer: { stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 12 } },
  }, { word: 'scale', wordStagger: 0.03 }),

  preset('karaoke', 'Karaoke', 'karaoke', 'Toute la phrase, le mot prononcé se colore', {
    reveal: 'karaoke',
    upcomingColor: '#FFFFFF',
    upcomingOpacity: 0.55,
    activeWord: { enabled: true, color: '#FFE500', scale: 1.0 },
  }, { word: 'none', wordStagger: 0, cueFade: 0.1 }),

  /* ------------------------------------------------------------------------
   * The word-by-word family.
   *
   * These are the styles built for short vertical video: one or two very large
   * words at a time, a hard entrance on every syllable, and — through
   * `activeMotion` — motion that continues for as long as the word is being
   * spoken instead of freezing the instant it has appeared.
   * ---------------------------------------------------------------------- */

  preset(
    'hyperWord',
    'Hyper Mot',
    'viral',
    'Un seul mot, énorme, qui claque à chaque syllabe',
    {
      reveal: 'wordByWord',
      visibleWords: 1,
      fontSizeRatio: 0.115,
      position: 'center',
      lineHeight: 1.05,
      maxWidthRatio: 0.9,
      activeWord: { enabled: true, color: '#FFE500', scale: 1 },
      emphasisColor: '#FFE500',
      emphasisScale: 1,
      layer: {
        stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 16 },
        shadow: { ...DEFAULT_CAPTION_STYLE.layer.shadow, y: 10, blur: 26, opacity: 0.6 },
      },
    },
    {
      word: 'impact',
      wordDuration: 0.16,
      wordStagger: 0,
      scaleFrom: 0.62,
      distance: 40,
      activeMotion: 'pulse',
      activeMotionAmount: 1,
    },
  ),

  preset(
    'punchLine',
    'Punch Line',
    'viral',
    'Trois mots blancs, celui qui parle passe en jaune et grossit',
    {
      reveal: 'karaoke',
      visibleWords: 3,
      fontSizeRatio: 0.086,
      maxWidthRatio: 0.78,
      lineHeight: 1.14,
      upcomingOpacity: 1,
      activeWord: { enabled: true, color: '#FFE500', scale: 1.22 },
      layer: { stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 13 } },
    },
    {
      word: 'spring',
      wordDuration: 0.26,
      wordStagger: 0.05,
      scaleFrom: 0.7,
      activeMotion: 'breathe',
      activeMotionAmount: 0.8,
    },
  ),

  preset(
    'stackDuo',
    'Duo Empilé',
    'viral',
    'Deux mots superposés qui tombent l’un après l’autre',
    {
      reveal: 'wordByWord',
      visibleWords: 2,
      fontSizeRatio: 0.098,
      // A narrow block forces the pair to stack instead of sitting side by side.
      maxWidthRatio: 0.42,
      lineHeight: 1.2,
      position: 'center',
      activeWord: { enabled: true, color: '#FFE500', scale: 1.06 },
      layer: { stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 14 } },
    },
    {
      word: 'dropIn',
      wordDuration: 0.3,
      wordStagger: 0,
      distance: 90,
      activeMotion: 'none',
    },
  ),

  preset(
    'chaos',
    'Chaos',
    'viral',
    'Mots inclinés au hasard, arrivée fouettée',
    {
      reveal: 'wordByWord',
      visibleWords: 2,
      fontSizeRatio: 0.092,
      maxWidthRatio: 0.6,
      // Each word keeps its own lean: derived from the word, never re-rolled.
      wordTilt: 7,
      activeWord: { enabled: true, color: '#FF4D6D', scale: 1.1 },
      layer: { stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 13 } },
    },
    {
      word: 'whip',
      wordDuration: 0.2,
      wordStagger: 0.03,
      distance: 130,
      rotation: 22,
      scaleFrom: 0.7,
      activeMotion: 'wobble',
      activeMotionAmount: 0.7,
    },
  ),

  preset(
    'spotlight',
    'Projecteur',
    'karaoke',
    'La phrase reste en retrait, seul le mot dit est éclairé',
    {
      reveal: 'karaoke',
      fontSizeRatio: 0.07,
      upcomingOpacity: 0.32,
      activeWord: { enabled: true, color: '#FFFFFF', scale: 1.16, glow: true },
      layer: {
        glow: { enabled: false, color: '#FFFFFF', intensity: 1.2, blur: 30, opacity: 0.6 },
        stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 8 },
      },
    },
    {
      word: 'riseUp',
      wordDuration: 0.28,
      wordStagger: 0.04,
      distance: 40,
      scaleFrom: 0.85,
      activeMotion: 'float',
      activeMotionAmount: 0.6,
    },
  ),

  preset(
    'keywords',
    'Mots-clés',
    'viral',
    'Phrase entière, les mots importants en jaune et en italique',
    {
      reveal: 'all',
      fontSizeRatio: 0.062,
      uppercase: false,
      maxWidthRatio: 0.8,
      activeWord: { enabled: false },
      emphasisColor: '#FFE500',
      emphasisScale: 1.06,
      // Reproduces the mixed-weight look of hand-made captions.
      emphasisItalic: true,
      layer: { stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 8 } },
    },
    { word: 'riseUp', wordDuration: 0.24, wordStagger: 0.045, distance: 26, scaleFrom: 0.9 },
  ),

  preset(
    'cinema',
    'Cinéma',
    'basic',
    'Discret, arrivée en fondu net depuis le flou',
    {
      reveal: 'all',
      fontFamily: 'Arial',
      fontWeight: 700,
      fontSizeRatio: 0.045,
      uppercase: false,
      maxWidthRatio: 0.72,
      letterSpacing: 0.5,
      activeWord: { enabled: false },
      layer: {
        stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 3, opacity: 0.7 },
        shadow: { ...DEFAULT_CAPTION_STYLE.layer.shadow, y: 3, blur: 14, opacity: 0.65 },
      },
    },
    { word: 'zoomBlur', wordDuration: 0.34, wordStagger: 0.02, blurFrom: 10 },
  ),

  preset(
    'flash',
    'Flash Néon',
    'music',
    'Un mot qui s’allume comme un néon',
    {
      reveal: 'wordByWord',
      visibleWords: 1,
      fontSizeRatio: 0.1,
      position: 'center',
      activeWord: { enabled: true, color: '#39FFEA', scale: 1, glow: true },
      layer: {
        stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 7, color: '#06121A' },
        glow: { enabled: true, color: '#39FFEA', intensity: 1.5, blur: 36, opacity: 0.8 },
      },
    },
    {
      word: 'flicker',
      wordDuration: 0.3,
      wordStagger: 0,
      scaleFrom: 0.88,
      activeMotion: 'pulse',
      activeMotionAmount: 0.7,
    },
  ),

  preset('viralPop', 'Viral Pop', 'viral', 'Mot par mot, entrée en pop élastique', {
    reveal: 'wordByWord',
    visibleWords: 1,
    fontSizeRatio: 0.085,
    activeWord: { enabled: true, color: '#FFE500', scale: 1 },
    layer: { stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 12 } },
  }, { word: 'pop', wordDuration: 0.2, scaleFrom: 0.55, wordStagger: 0 }),

  preset('punchy', 'Punchy', 'viral', 'Trois mots, le mot actif grossit fort', {
    reveal: 'karaoke',
    visibleWords: 3,
    fontSizeRatio: 0.075,
    activeWord: { enabled: true, color: '#00E5FF', scale: 1.18 },
    // `spring` settles around its final size instead of overshooting past it,
    // so a word this large never collides with the one before it.
  }, { word: 'spring', wordDuration: 0.22, wordStagger: 0.04 }),

  preset('highlightBox', 'Box', 'viral', 'Le mot actif reçoit un fond arrondi', {
    reveal: 'karaoke',
    activeWord: {
      enabled: true,
      color: '#101216',
      scale: 1.05,
      box: true,
      boxColor: '#FFE500',
      boxRadius: 16,
      boxPadding: 16,
    },
  }, { word: 'scale', wordStagger: 0.03, wordDuration: 0.18 }),

  preset('neon', 'Neon', 'viral', 'Halo lumineux, contour coloré', {
    reveal: 'karaoke',
    activeWord: { enabled: true, color: '#39FFEA', scale: 1.1, glow: true },
    layer: {
      fill: { ...DEFAULT_CAPTION_STYLE.layer.fill, color: '#FFFFFF' },
      stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 6, color: '#0B0F14' },
      glow: { enabled: true, color: '#39FFEA', intensity: 1.4, blur: 34, opacity: 0.75 },
      shadow: { ...DEFAULT_CAPTION_STYLE.layer.shadow, opacity: 0.4 },
    },
  }, { word: 'glow', wordDuration: 0.24, wordStagger: 0.05 }),

  preset('threeD', '3D', 'viral', 'Réutilise l’extrusion du moteur 3D', {
    reveal: 'wordByWord',
    visibleWords: 2,
    fontSizeRatio: 0.078,
    activeWord: { enabled: false },
    layer: {
      fill: {
        ...DEFAULT_CAPTION_STYLE.layer.fill,
        kind: 'glossy',
        color: '#FFE500',
        color2: '#FFC000',
      },
      stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 7, color: '#FFF9B5' },
      extrusion: {
        enabled: true,
        depth: 14,
        dirX: 2,
        dirY: 5,
        steps: 18,
        color: '#E5B800',
        color2: '#7A5B00',
        gradient: true,
        opacity: 1,
        blur: 0,
      },
      gloss: { ...DEFAULT_CAPTION_STYLE.layer.gloss, enabled: true },
    },
  }, { word: 'bounce', wordDuration: 0.3, scaleFrom: 0.6 }),

  preset('rap', 'Rap', 'music', 'Un mot à la fois, très réactif', {
    reveal: 'wordByWord',
    visibleWords: 1,
    fontSizeRatio: 0.095,
    activeWord: { enabled: false },
    layer: { stroke: { ...DEFAULT_CAPTION_STYLE.layer.stroke, width: 14 } },
  }, { word: 'punch', wordDuration: 0.12, scaleFrom: 0.8, wordStagger: 0 }),

  preset('lyrics', 'Music Lyrics', 'music', 'Ligne complète, progression karaoké douce', {
    reveal: 'karaoke',
    uppercase: false,
    fontSizeRatio: 0.058,
    upcomingOpacity: 0.4,
    activeWord: { enabled: true, color: '#FF6BB5', scale: 1.05, glow: true },
    layer: { glow: { enabled: true, color: '#FF6BB5', intensity: 1, blur: 26, opacity: 0.5 } },
  }, { word: 'fade', wordDuration: 0.3, wordStagger: 0 }),

  preset('podcast', 'Podcast', 'basic', 'Lisible, deux lignes, peu d’animation', {
    reveal: 'all',
    fontSizeRatio: 0.048,
    uppercase: false,
    maxWidthRatio: 0.8,
    position: 'bottom',
    activeWord: { enabled: true, color: '#FFE500', scale: 1 },
  }, { word: 'fade', wordDuration: 0.2, wordStagger: 0 }),

  preset('story', 'Storytelling', 'viral', 'Deux mots, glissement vers le haut', {
    reveal: 'wordByWord',
    visibleWords: 2,
    position: 'center',
    offsetYRatio: 0,
    activeWord: { enabled: true, color: '#FFE500', scale: 1.08 },
  }, { word: 'slideUp', distance: 70, wordDuration: 0.26, wordStagger: 0.05 }),
];

export function findCaptionPreset(id: string): CaptionPreset | undefined {
  return BUILTIN_CAPTION_PRESETS.find((preset) => preset.id === id);
}

export function cloneCaptionStyle(style: CaptionStyle): CaptionStyle {
  return {
    ...style,
    layer: cloneStyle(style.layer),
    activeWord: { ...style.activeWord },
  };
}
