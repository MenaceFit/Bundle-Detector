import { useRef } from 'react';
import { useVideoStore } from '@/videoproject/store';
import { formatTimecode } from '@/utils/format';
import { clamp } from '@/utils/math';

/**
 * Word-level timeline.
 *
 * Every word is a block placed on the real time axis, so the transcript's
 * synchronisation is visible at a glance: clicking a word seeks the player to
 * the exact moment it is spoken.
 */
export function CaptionTimeline() {
  const metadata = useVideoStore((state) => state.metadata);
  const track = useVideoStore((state) => state.track);
  const waveform = useVideoStore((state) => state.waveform);
  const time = useVideoStore((state) => state.time);
  const selectedWordId = useVideoStore((state) => state.selectedWordId);
  const setTime = useVideoStore((state) => state.setTime);
  const setPlaying = useVideoStore((state) => state.setPlaying);
  const selectWord = useVideoStore((state) => state.selectWord);
  const laneRef = useRef<HTMLDivElement>(null);

  const duration = metadata?.durationSec ?? 0;
  if (!metadata) return null;

  const ratio = (value: number): number => (duration > 0 ? clamp(value / duration, 0, 1) : 0);

  const scrub = (clientX: number): void => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setPlaying(false);
    setTime(((clientX - rect.left) / rect.width) * duration);
  };

  return (
    <section className="vc-timeline">
      <div className="vc-timeline-head">
        <span className="chip">{track.cues.length} sous-titres</span>
        <span className="chip">
          {track.cues.reduce((sum, cue) => sum + cue.words.length, 0)} mots
        </span>
        <div style={{ flex: 1 }} />
        <span className="timecode">
          {formatTimecode(time)} / {formatTimecode(duration)}
        </span>
      </div>

      <div
        className="vc-lane"
        ref={laneRef}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          scrub(event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) scrub(event.clientX);
        }}
      >
        {waveform.length > 0 && (
          <div className="vc-waveform" aria-hidden>
            {waveform.map((peak, index) => (
              <span
                key={index}
                style={{ height: `${Math.max(2, peak * 100)}%` }}
              />
            ))}
          </div>
        )}

        {track.cues.map((cue) => (
          <div
            key={cue.id}
            className="vc-cue"
            style={{
              left: `${ratio(cue.start) * 100}%`,
              width: `${Math.max(0.4, (ratio(cue.end) - ratio(cue.start)) * 100)}%`,
            }}
            title={cue.text}
          />
        ))}

        {track.cues.flatMap((cue) =>
          cue.words.map((word) => (
            <button
              key={word.id}
              type="button"
              className={`vc-word${selectedWordId === word.id ? ' selected' : ''}${
                word.emphasis ? ' emphasis' : ''
              }`}
              style={{
                left: `${ratio(word.start) * 100}%`,
                width: `${Math.max(0.25, (ratio(word.end) - ratio(word.start)) * 100)}%`,
              }}
              title={`${word.text} — ${word.start.toFixed(2)}s → ${word.end.toFixed(2)}s`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                selectWord(word.id);
                setPlaying(false);
                setTime(word.start);
              }}
            >
              <span>{word.text}</span>
            </button>
          )),
        )}

        <div className="playhead" style={{ left: `${ratio(time) * 100}%` }} />
      </div>
    </section>
  );
}
