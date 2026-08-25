/**
 * Caption domain model.
 *
 * Transcription and caption rendering are deliberately separate concerns:
 * `Transcript` holds *what was said and when*, and carries no styling; a
 * `CaptionTrack` turns that into timed, styled, animatable groups. Re-styling a
 * video therefore never touches the timings, and correcting a word never
 * invalidates a style.
 */

import type { LayerStyle } from '@/types';

/* -------------------------------------------------------------- metadata */

export interface VideoMetadata {
  /** Absolute path on disk. The source file is never modified. */
  path: string;
  fileName: string;
  fileSize: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  /** Null when the file carries no audio stream at all. */
  audio: AudioMetadata | null;
}

export interface AudioMetadata {
  codec: string;
  sampleRate: number;
  channels: number;
  /** Layout label as reported by ffprobe ("mono", "stereo", …). */
  channelLayout: string;
}

/* ------------------------------------------------------------ transcript */

export interface WordTimestamp {
  id: string;
  text: string;
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  /** 0..1 when the engine reports it. Low values drive the review warnings. */
  confidence?: number;
  /** Marked as a keyword, automatically or by hand. */
  emphasis?: boolean;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  /** Indices into `Transcript.words`. */
  wordIds: string[];
}

export interface Transcript {
  language: string;
  /** Confidence of the language detection, when the engine reports one. */
  languageConfidence?: number;
  words: WordTimestamp[];
  /** Sentence-level grouping as returned by the engine, before re-segmentation. */
  segments: TranscriptSegment[];
  /** Which engine and model produced this, for the debug panel. */
  source: { engine: string; model: string };
}

/* -------------------------------------------------------------- captions */

/** One on-screen caption: a group of words shown together. */
export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  words: WordTimestamp[];
  /** Flattened text, kept in sync with `words`. */
  text: string;
}

export interface CaptionTrack {
  cues: CaptionCue[];
}

/* ---------------------------------------------------------------- styles */

export type CaptionPosition = 'top' | 'center' | 'bottom' | 'custom';

export type WordAnimationKind =
  | 'none'
  | 'pop'
  | 'bounce'
  | 'scale'
  | 'fade'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'rotate'
  | 'flip'
  | 'blur'
  | 'elastic'
  | 'shake'
  | 'punch'
  | 'glow'
  // High-energy entrances, for the word-by-word styles.
  | 'spring'
  | 'impact'
  | 'whip'
  | 'dropIn'
  | 'zoomBlur'
  | 'swing'
  | 'riseUp'
  | 'flicker';

/**
 * Continuous motion applied to the word currently being spoken, *after* its
 * entrance has finished.
 *
 * Without it a caption is only ever animated for the fraction of a second a
 * word appears, and then freezes — which is exactly what makes static captions
 * look flat next to the dynamic ones. This keeps the live word breathing for as
 * long as it is being said, without touching its timing.
 */
export type ActiveMotionKind = 'none' | 'pulse' | 'breathe' | 'wobble' | 'float';

/** How the words of a cue are revealed relative to the audio. */
export type RevealMode =
  | 'all'        // the whole cue is visible for its duration
  | 'wordByWord' // words appear as they are spoken
  | 'karaoke';   // all words visible, the spoken one is highlighted

export interface ActiveWordStyle {
  enabled: boolean;
  color: string;
  /** Multiplier applied to the active word's size. */
  scale: number;
  glow: boolean;
  /** Rounded box drawn behind the active word. */
  box: boolean;
  boxColor: string;
  boxRadius: number;
  boxPadding: number;
  boxOpacity: number;
}

export interface CaptionStyle {
  /** Reuses the 3D text engine's style model verbatim — one engine, one model. */
  layer: LayerStyle;
  fontFamily: string;
  fontWeight: number;
  /** Font size as a fraction of the video height, so a style is resolution-independent. */
  fontSizeRatio: number;
  letterSpacing: number;
  lineHeight: number;
  uppercase: boolean;
  /** Maximum text width as a fraction of the video width. */
  maxWidthRatio: number;
  position: CaptionPosition;
  /** Vertical placement as a fraction of the video height (used by every position). */
  offsetYRatio: number;
  offsetXRatio: number;
  reveal: RevealMode;
  /** How many words stay visible in `wordByWord` mode. */
  visibleWords: number;
  activeWord: ActiveWordStyle;
  /** Colour of words not yet spoken, in karaoke mode. */
  upcomingColor: string;
  upcomingOpacity: number;
  emphasisColor: string;
  emphasisScale: number;
  /** Emphasised words are also italicised, the way hand-made captions do it. */
  emphasisItalic: boolean;
  /**
   * Maximum random tilt per word, in degrees. Derived from the word itself, so
   * a given word always leans the same way — a caption that re-rolled its angles
   * every frame would vibrate.
   */
  wordTilt: number;
}

export interface CaptionAnimation {
  word: WordAnimationKind;
  /** Duration of a single word's entrance, in seconds. */
  wordDuration: number;
  /** Delay between consecutive words of the same cue, in seconds. */
  wordStagger: number;
  /** Per-character stagger inside a word; 0 disables character animation. */
  characterStagger: number;
  distance: number;
  rotation: number;
  scaleFrom: number;
  blurFrom: number;
  /** Entrance/exit of the whole cue block. */
  cueFade: number;
  /** Continuous motion of the word being spoken, once it has finished entering. */
  activeMotion: ActiveMotionKind;
  /** Amplitude of `activeMotion`, 0 disables it. */
  activeMotionAmount: number;
}

export interface CaptionPreset {
  id: string;
  name: string;
  category: 'basic' | 'viral' | 'karaoke' | 'music' | 'custom';
  description: string;
  builtin: boolean;
  style: CaptionStyle;
  animation: CaptionAnimation;
}

/* ------------------------------------------------------- segmentation */

export interface SegmentationOptions {
  /** `null` picks the count automatically from rhythm and length. */
  wordsPerCue: number | null;
  /** Hard ceiling on how long one cue may stay up. */
  maxDurationSec: number;
  /** Below this, a cue is merged with its neighbour. */
  minDurationSec: number;
  /** Maximum characters per cue, to keep lines readable. */
  maxCharacters: number;
  /** A silence at least this long always breaks a cue. */
  pauseBreakSec: number;
  /** Break on sentence-ending punctuation. */
  respectPunctuation: boolean;
}
