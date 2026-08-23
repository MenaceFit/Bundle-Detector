import type { Transcript, TranscriptSegment, WordTimestamp } from '@/captions/types';
import { generateId } from '@/utils/object';

/**
 * Cleans up raw ASR output.
 *
 * Whisper-family models emit chunks whose text carries leading spaces, and
 * occasionally a chunk with a missing or inverted timestamp. Downstream
 * everything assumes words are trimmed, ordered and monotonic, so that
 * invariant is established exactly once, here.
 */

export interface RawChunk {
  text: string;
  /** [start, end] in seconds; either may be null when the model is unsure. */
  timestamp: [number | null, number | null];
  confidence?: number;
}

/**
 * Turns raw chunks into ordered words with usable timings.
 *
 * A missing timestamp is interpolated from its neighbours rather than dropped:
 * losing the word entirely would desynchronise everything after it, which is
 * far worse than a slightly approximate boundary.
 */
export function normalizeWords(chunks: RawChunk[], totalDuration: number): WordTimestamp[] {
  const cleaned = chunks
    .map((chunk) => ({ ...chunk, text: chunk.text.trim() }))
    .filter((chunk) => chunk.text.length > 0);

  if (cleaned.length === 0) return [];

  const words: WordTimestamp[] = [];
  let cursor = 0;

  cleaned.forEach((chunk, index) => {
    const nextKnown = findNextStart(cleaned, index + 1);
    let start = chunk.timestamp[0];
    let end = chunk.timestamp[1];

    if (start === null || !Number.isFinite(start)) start = cursor;
    if (end === null || !Number.isFinite(end)) {
      // Fall back to the next known start, then to a short default.
      end = nextKnown !== null ? nextKnown : start + 0.24;
    }

    // Never let a word start before the previous one ended.
    start = Math.max(start, cursor);
    if (end <= start) end = start + 0.08;
    if (totalDuration > 0) {
      start = Math.min(start, totalDuration);
      end = Math.min(end, totalDuration);
      if (end <= start) end = Math.min(totalDuration, start + 0.05);
    }

    words.push({
      id: generateId('w'),
      text: chunk.text,
      start,
      end,
      ...(chunk.confidence === undefined ? {} : { confidence: chunk.confidence }),
    });
    cursor = end;
  });

  return words;
}

function findNextStart(chunks: RawChunk[], from: number): number | null {
  for (let i = from; i < chunks.length; i += 1) {
    const value = chunks[i]?.timestamp[0];
    if (value !== null && value !== undefined && Number.isFinite(value)) return value;
  }
  return null;
}

/** Groups words into sentence-level segments, mirroring the engine's own output. */
export function buildSegments(words: WordTimestamp[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: WordTimestamp[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    segments.push({
      id: generateId('seg'),
      text: current.map((word) => word.text).join(' '),
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      wordIds: current.map((word) => word.id),
    });
    current = [];
  };

  for (const word of words) {
    current.push(word);
    if (/[.!?…]["'»)\]]*$/.test(word.text)) flush();
  }
  flush();
  return segments;
}

/**
 * Words whose timing or confidence deserves a look before export.
 *
 * Surfacing these is the difference between "the transcript is probably fine"
 * and knowing exactly which three words to check.
 */
export function lowConfidenceWords(
  transcript: Transcript,
  threshold = 0.5,
): WordTimestamp[] {
  return transcript.words.filter(
    (word) => word.confidence !== undefined && word.confidence < threshold,
  );
}

/**
 * Marks words worth emphasising.
 *
 * This is deliberately shallow — length, rarity within the transcript and
 * proximity to sentence-final punctuation. It is a starting point the user
 * edits, not an understanding of the content, and it is never applied silently.
 */
export function suggestEmphasis(words: WordTimestamp[], maxRatio = 0.15): Set<string> {
  const counts = new Map<string, number>();
  for (const word of words) {
    const key = word.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (key.length === 0) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const scored = words
    .map((word) => {
      const key = word.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (key.length < 4) return { word, score: 0 };
      const repetitions = counts.get(key) ?? 1;
      // Long, rarely repeated, and slowly articulated words stand out.
      const duration = word.end - word.start;
      const score = key.length * 0.6 + duration * 4 - repetitions * 1.5;
      return { word, score };
    })
    .filter((entry) => entry.score > 3)
    .sort((a, b) => b.score - a.score);

  const limit = Math.max(1, Math.floor(words.length * maxRatio));
  return new Set(scored.slice(0, limit).map((entry) => entry.word.id));
}

export function applyEmphasis(words: WordTimestamp[], ids: Set<string>): WordTimestamp[] {
  return words.map((word) => ({ ...word, emphasis: ids.has(word.id) }));
}
