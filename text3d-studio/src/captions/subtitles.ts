import type { CaptionCue, CaptionStyle, CaptionTrack, Transcript } from './types';
import { parseColor } from '@/utils/color';

/**
 * Subtitle file writers.
 *
 * Timings come straight from the caption track, so an exported file always
 * matches what the preview showed. Only the container differs.
 */

/** `HH:MM:SS,mmm` — SRT uses a comma before the milliseconds. */
export function formatSrtTime(seconds: number): string {
  return formatClock(seconds, ',');
}

/** `HH:MM:SS.mmm` — WebVTT uses a dot. */
export function formatVttTime(seconds: number): string {
  return formatClock(seconds, '.');
}

/** `H:MM:SS.cc` — ASS uses centiseconds and a single-digit hour. */
export function formatAssTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.round((safe - Math.floor(safe)) * 100);
  // Rounding can carry into the next second.
  const carry = centis === 100;
  return `${hours}:${pad(minutes, 2)}:${pad(carry ? secs + 1 : secs, 2)}.${pad(carry ? 0 : centis, 2)}`;
}

function formatClock(seconds: number, separator: ',' | '.'): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  const carry = millis === 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(carry ? secs + 1 : secs, 2)}${separator}${pad(
    carry ? 0 : millis,
    3,
  )}`;
}

function pad(value: number, size: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(size, '0');
}

export function toSrt(track: CaptionTrack): string {
  return track.cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`,
    )
    .join('\n');
}

export function toVtt(track: CaptionTrack): string {
  const body = track.cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}\n${cue.text}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** ASS colours are `&HAABBGGRR`, with alpha inverted (00 = opaque). */
export function toAssColor(hex: string, opacity = 1): string {
  const { r, g, b, a } = parseColor(hex);
  const alpha = Math.round((1 - Math.min(1, Math.max(0, a * opacity))) * 255);
  const part = (n: number): string => Math.round(n).toString(16).padStart(2, '0').toUpperCase();
  return `&H${part(alpha)}${part(b)}${part(g)}${part(r)}`;
}

/**
 * Advanced SubStation Alpha, which unlike SRT keeps font, colours, outline,
 * shadow and placement. Word-level animation cannot be expressed, so a cue is
 * written as one styled line — the burned-in MP4 remains the faithful output.
 */
export function toAss(
  track: CaptionTrack,
  style: CaptionStyle,
  video: { width: number; height: number },
): string {
  const fontSize = Math.round(style.fontSizeRatio * video.height);
  const outline = Math.round(style.layer.stroke.enabled ? style.layer.stroke.width : 0);
  const shadow = style.layer.shadow.enabled ? Math.round(Math.abs(style.layer.shadow.y)) : 0;
  // ASS alignment numpad: 2 = bottom centre, 5 = middle centre, 8 = top centre.
  const alignment = style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2;
  const marginV = Math.round(Math.abs(style.offsetYRatio) * video.height);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Default',
      escapeAssField(style.fontFamily),
      String(fontSize),
      toAssColor(style.layer.fill.color),
      toAssColor(style.activeWord.color),
      toAssColor(style.layer.stroke.color),
      toAssColor(style.layer.shadow.color, style.layer.shadow.opacity),
      style.fontWeight >= 600 ? '-1' : '0',
      '0',
      '0',
      '0',
      '100',
      '100',
      String(Math.round(style.letterSpacing)),
      '0',
      '1',
      String(outline),
      String(shadow),
      String(alignment),
      '40',
      '40',
      String(marginV),
      '1',
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = track.cues
    .map(
      (cue) =>
        `Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(cue.end)},Default,,0,0,0,,${escapeAssText(
          cue.text,
        )}`,
    )
    .join('\n');

  return `${header}\n${events}\n`;
}

/** Commas separate fields in a style line, so they cannot survive in a value. */
function escapeAssField(value: string): string {
  return value.replace(/,/g, ' ');
}

function escapeAssText(value: string): string {
  return value.replace(/\r?\n/g, '\\N').replace(/\{/g, '(').replace(/\}/g, ')');
}

/**
 * Lossless JSON export: unlike SRT/VTT/ASS this keeps per-word timings, so a
 * project can be reconstructed or fed to another tool without loss.
 */
export function toCaptionJson(
  track: CaptionTrack,
  transcript: Transcript | null,
): string {
  return JSON.stringify(
    {
      version: 1,
      language: transcript?.language ?? null,
      source: transcript?.source ?? null,
      cues: track.cues.map((cue) => ({
        start: cue.start,
        end: cue.end,
        text: cue.text,
        words: cue.words.map((word) => ({
          text: word.text,
          start: word.start,
          end: word.end,
          ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
          ...(word.emphasis ? { emphasis: true } : {}),
        })),
      })),
    },
    null,
    2,
  );
}

export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'json';

export function renderSubtitles(
  format: SubtitleFormat,
  track: CaptionTrack,
  style: CaptionStyle,
  video: { width: number; height: number },
  transcript: Transcript | null,
): string {
  switch (format) {
    case 'srt':
      return toSrt(track);
    case 'vtt':
      return toVtt(track);
    case 'ass':
      return toAss(track, style, video);
    case 'json':
      return toCaptionJson(track, transcript);
    default:
      return toSrt(track);
  }
}

/** Parses an SRT file back into cues, for importing an existing subtitle file. */
export function parseSrt(content: string): CaptionCue[] {
  const blocks = content.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const cues: CaptionCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2) continue;
    const timingLine = lines.find((line) => line.includes('-->'));
    if (!timingLine) continue;

    const [rawStart, rawEnd] = timingLine.split('-->').map((part) => part.trim());
    const start = parseClock(rawStart ?? '');
    const end = parseClock(rawEnd ?? '');
    if (start === null || end === null) continue;

    const textLines = lines.slice(lines.indexOf(timingLine) + 1);
    const text = textLines.join(' ').trim();
    if (text.length === 0) continue;

    cues.push({
      id: `srt_${cues.length}`,
      start,
      end: Math.max(end, start + 0.05),
      text,
      // Without word timings, spread the words evenly across the cue.
      words: distributeWords(text, start, end, cues.length),
    });
  }

  return cues;
}

function distributeWords(text: string, start: number, end: number, cueIndex: number) {
  const parts = text.split(/\s+/).filter(Boolean);
  const step = parts.length > 0 ? (end - start) / parts.length : 0;
  return parts.map((word, index) => ({
    id: `srt_${cueIndex}_${index}`,
    text: word,
    start: start + step * index,
    end: start + step * (index + 1),
  }));
}

function parseClock(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return (
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number((ms ?? '0').padEnd(3, '0')) / 1000
  );
}
