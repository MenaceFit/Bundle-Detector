import type {
  CaptionCue,
  CaptionTrack,
  SegmentationOptions,
  Transcript,
  WordTimestamp,
} from './types';
import { generateId } from '@/utils/object';
import { clamp } from '@/utils/math';

export const DEFAULT_SEGMENTATION: SegmentationOptions = {
  wordsPerCue: null,
  maxDurationSec: 3.2,
  minDurationSec: 0.35,
  maxCharacters: 42,
  pauseBreakSec: 0.45,
  respectPunctuation: true,
};

/**
 * Cue length the automatic mode aims for. Short enough that the caption keeps
 * moving with the voice, long enough that the viewer is not reading a strobe.
 */
const TARGET_CUE_SEC = 1.35;

const SENTENCE_END = /[.!?…]["'»)\]]*$/;
const CLAUSE_END = /[,;:][\"'»)\]]*$/;

/**
 * Groups timed words into readable cues.
 *
 * Breaks are driven, in order of strength, by: a silence long enough to be a
 * real pause, sentence-ending punctuation, then the soft budgets (duration,
 * character count, word count). When a budget is nearly spent the splitter
 * looks for a clause boundary slightly early rather than cutting mid-phrase —
 * that is what keeps "les meilleures opportunités / sur internet" from becoming
 * "les meilleures / opportunités sur internet".
 */
export function segmentWords(
  words: WordTimestamp[],
  options: SegmentationOptions = DEFAULT_SEGMENTATION,
): CaptionCue[] {
  const usable = words.filter((word) => word.text.trim().length > 0);
  if (usable.length === 0) return [];

  const targetWords = options.wordsPerCue ?? autoWordsPerCue(usable);
  const cues: CaptionCue[] = [];
  let current: WordTimestamp[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    cues.push(makeCue(current));
    current = [];
  };

  for (let i = 0; i < usable.length; i += 1) {
    const word = usable[i]!;
    current.push(word);

    const next = usable[i + 1];
    if (!next) break;

    const pause = next.start - word.end;
    const duration = next.end - current[0]!.start;
    const characters = textOf(current).length + 1 + next.text.length;
    const count = current.length;

    // A real silence is the strongest signal available: it is where the speaker
    // themselves broke the phrase.
    if (pause >= options.pauseBreakSec) {
      flush();
      continue;
    }

    if (options.respectPunctuation && SENTENCE_END.test(word.text)) {
      flush();
      continue;
    }

    const overBudget =
      count >= targetWords ||
      duration > options.maxDurationSec ||
      characters > options.maxCharacters;

    if (!overBudget) continue;

    // Budget spent: break here, unless the previous word ended a clause and the
    // cue is already long enough to stand alone.
    if (
      options.respectPunctuation &&
      count > 1 &&
      CLAUSE_END.test(word.text) &&
      cueDuration(current) >= options.minDurationSec
    ) {
      flush();
      continue;
    }

    flush();
  }

  flush();
  return mergeShortCues(cues, options);
}

/**
 * Words per cue derived from the actual speech rate, so a fast rap and a slow
 * podcast both land on cues of roughly `TARGET_CUE_SEC`.
 */
export function autoWordsPerCue(words: WordTimestamp[]): number {
  if (words.length < 2) return 1;
  const first = words[0]!;
  const last = words[words.length - 1]!;
  const span = Math.max(0.001, last.end - first.start);
  const wordsPerSecond = words.length / span;
  return clamp(Math.round(wordsPerSecond * TARGET_CUE_SEC), 1, 8);
}

/**
 * Folds a cue too brief to read into a neighbour.
 *
 * Merging has to work in both directions: a short cue joins the one before it,
 * but a short *leading* cue has nothing before it and must absorb the one that
 * follows instead — otherwise a one-word opener flashes by unreadably.
 */
function mergeShortCues(cues: CaptionCue[], options: SegmentationOptions): CaptionCue[] {
  if (cues.length < 2) return cues;

  const tooShort = (cue: CaptionCue): boolean => cue.end - cue.start < options.minDurationSec;
  const fits = (a: CaptionCue, b: CaptionCue): boolean => {
    const merged = [...a.words, ...b.words];
    return (
      textOf(merged).length <= options.maxCharacters &&
      merged[merged.length - 1]!.end - merged[0]!.start <= options.maxDurationSec
    );
  };

  const out: CaptionCue[] = [];
  for (const cue of cues) {
    const previous = out[out.length - 1];
    if (previous && (tooShort(previous) || tooShort(cue)) && fits(previous, cue)) {
      out[out.length - 1] = makeCue([...previous.words, ...cue.words]);
      continue;
    }
    out.push(cue);
  }
  return out;
}

function makeCue(words: WordTimestamp[]): CaptionCue {
  const first = words[0]!;
  const last = words[words.length - 1]!;
  return {
    id: generateId('cue'),
    start: first.start,
    // Guard against an engine reporting end <= start on a clipped word.
    end: Math.max(last.end, first.start + 0.05),
    words: [...words],
    text: textOf(words),
  };
}

function cueDuration(words: WordTimestamp[]): number {
  if (words.length === 0) return 0;
  return words[words.length - 1]!.end - words[0]!.start;
}

function textOf(words: WordTimestamp[]): string {
  return words.map((word) => word.text).join(' ');
}

export function buildCaptionTrack(
  transcript: Transcript,
  options: SegmentationOptions = DEFAULT_SEGMENTATION,
): CaptionTrack {
  return { cues: segmentWords(transcript.words, options) };
}

/** The cue visible at `time`, or undefined between cues. */
export function cueAt(track: CaptionTrack, time: number): CaptionCue | undefined {
  return track.cues.find((cue) => time >= cue.start && time < cue.end);
}

/**
 * Index of the word being spoken at `time` inside `cue`.
 *
 * Returns the last word that has started rather than -1 during the micro-gaps
 * between words, so a karaoke highlight does not flicker off between syllables.
 */
export function activeWordIndex(cue: CaptionCue, time: number): number {
  let index = -1;
  for (let i = 0; i < cue.words.length; i += 1) {
    const word = cue.words[i]!;
    if (time >= word.start) index = i;
    if (time < word.end) break;
  }
  return index;
}

/** Rebuilds a cue's cached text and bounds after its words were edited. */
export function refreshCue(cue: CaptionCue): CaptionCue {
  if (cue.words.length === 0) return { ...cue, text: '' };
  return makeCue(cue.words);
}
