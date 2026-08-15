import { useRef, useState } from 'react';
import { useStore } from '@/state/store';
import { useActiveLayer } from '@/state/hooks';
import { propertyLabel } from '@/animation/properties';
import { EASING_KINDS, EASING_LABELS } from '@/animation/easing';
import { formatTimecode } from '@/utils/format';
import { clamp } from '@/utils/math';
import type { EasingKind } from '@/types';

interface Selection {
  property: string;
  keyframeId: string;
}

export function Timeline() {
  const layer = useActiveLayer();
  const duration = useStore((state) => state.project.timeline.duration);
  const [selected, setSelected] = useState<Selection | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);

  const tracks = layer.animation.tracks;

  return (
    <section className="timeline">
      <TimelineControls selected={selected} onClearSelection={() => setSelected(null)} />
      <Ruler duration={duration} />
      <div className="tracks" ref={lanesRef}>
        {tracks.length === 0 ? (
          <div className="empty-tracks">
            Aucune propriété animée.
            <br />
            Placez la tête de lecture, modifiez une propriété puis cliquez sur son bouton{' '}
            <span className="kf-btn" style={{ display: 'inline-grid', verticalAlign: 'middle' }} />{' '}
            — ou appliquez une animation prédéfinie depuis le panneau Animation.
          </div>
        ) : (
          tracks.map((track) => (
            <TrackRow
              key={track.property}
              property={track.property}
              duration={duration}
              selected={selected}
              onSelect={setSelected}
            />
          ))
        )}
      </div>
    </section>
  );
}

function TimelineControls({
  selected,
  onClearSelection,
}: {
  selected: Selection | null;
  onClearSelection: () => void;
}) {
  const playing = useStore((state) => state.playing);
  const time = useStore((state) => state.time);
  const timeline = useStore((state) => state.project.timeline);
  const togglePlay = useStore((state) => state.togglePlay);
  const stop = useStore((state) => state.stop);
  const restart = useStore((state) => state.restart);
  const stepFrame = useStore((state) => state.stepFrame);
  const setTimeline = useStore((state) => state.setTimeline);
  const removeKeyframe = useStore((state) => state.removeKeyframe);
  const duplicateKeyframe = useStore((state) => state.duplicateKeyframe);
  const setKeyframeEasing = useStore((state) => state.setKeyframeEasing);
  const layer = useActiveLayer();

  const selectedKeyframe = selected
    ? layer.animation.tracks
        .find((track) => track.property === selected.property)
        ?.keyframes.find((kf) => kf.id === selected.keyframeId)
    : undefined;

  return (
    <div className="timeline-controls">
      <button type="button" className="btn btn-icon" title="Retour au début (Home)" onClick={restart}>
        ↩
      </button>
      <button
        type="button"
        className="btn btn-icon"
        title="Image précédente (←)"
        onClick={() => stepFrame(-1)}
      >
        ⏮
      </button>
      <button
        type="button"
        className="btn btn-primary btn-icon"
        title="Lecture / Pause (Espace)"
        onClick={togglePlay}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        className="btn btn-icon"
        title="Image suivante (→)"
        onClick={() => stepFrame(1)}
      >
        ⏭
      </button>
      <button type="button" className="btn btn-icon" title="Stop" onClick={stop}>
        ⏹
      </button>

      <span className="timecode">
        {formatTimecode(time)} / {formatTimecode(timeline.duration)}
      </span>

      <span className="chip">
        image {Math.round(time * timeline.fps)} / {Math.round(timeline.duration * timeline.fps)}
      </span>

      <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        FPS
        <select
          value={timeline.fps}
          onChange={(event) => setTimeline({ fps: Number(event.target.value) })}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-0)' }}
        >
          <option value={24}>24</option>
          <option value={30}>30</option>
          <option value={60}>60</option>
        </select>
      </label>

      <button
        type="button"
        className={`btn btn-sm${timeline.loop ? ' active' : ''}`}
        title="Lecture en boucle"
        onClick={() => setTimeline({ loop: !timeline.loop })}
      >
        ⟲ Boucle
      </button>

      <div style={{ flex: 1 }} />

      {selectedKeyframe && selected && (
        <>
          <span className="chip">
            {propertyLabel(selected.property)} @ {selectedKeyframe.time.toFixed(2)}s
          </span>
          <select
            className="input"
            style={{ width: 130 }}
            value={selectedKeyframe.easing}
            onChange={(event) =>
              setKeyframeEasing(selected.property, selected.keyframeId, event.target.value as EasingKind)
            }
          >
            {EASING_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {EASING_LABELS[kind]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            title="Dupliquer le keyframe"
            onClick={() => duplicateKeyframe(selected.property, selected.keyframeId)}
          >
            ⧉
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            title="Supprimer le keyframe (Suppr)"
            onClick={() => {
              removeKeyframe(selected.property, selected.keyframeId);
              onClearSelection();
            }}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

function Ruler({ duration }: { duration: number }) {
  const time = useStore((state) => state.time);
  const setTime = useStore((state) => state.setTime);
  const pause = useStore((state) => state.pause);
  const ref = useRef<HTMLDivElement>(null);

  const scrub = (clientX: number): void => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setTime(clamp((clientX - rect.left) / rect.width, 0, 1) * duration);
  };

  // Aim for a tick roughly every 90 px without knowing the pixel width yet:
  // a 10-step ruler reads well from 0.5 s to 30 s.
  const steps = 10;

  return (
    <div
      className="timeline-ruler"
      ref={ref}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        pause();
        scrub(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) scrub(event.clientX);
      }}
    >
      {Array.from({ length: steps + 1 }, (_, i) => (
        <div key={i} className="ruler-tick" style={{ left: `${(i / steps) * 100}%` }}>
          {((i / steps) * duration).toFixed(duration >= 10 ? 0 : 1)}s
        </div>
      ))}
      <div className="playhead" style={{ left: `${duration > 0 ? (time / duration) * 100 : 0}%` }} />
    </div>
  );
}

function TrackRow({
  property,
  duration,
  selected,
  onSelect,
}: {
  property: string;
  duration: number;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const layer = useActiveLayer();
  const moveKeyframe = useStore((state) => state.moveKeyframe);
  const removeTrack = useStore((state) => state.removeTrack);
  const setTime = useStore((state) => state.setTime);
  const laneRef = useRef<HTMLDivElement>(null);

  const track = layer.animation.tracks.find((t) => t.property === property);
  if (!track) return null;

  const toRatio = (value: number): number => (duration > 0 ? clamp(value / duration, 0, 1) : 0);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>, keyframeId: string): void => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect({ property, keyframeId });

    const onMove = (moveEvent: PointerEvent): void => {
      const rect = laneRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const ratio = clamp((moveEvent.clientX - rect.left) / rect.width, 0, 1);
      moveKeyframe(property, keyframeId, ratio * duration);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const sorted = [...track.keyframes].sort((a, b) => a.time - b.time);

  return (
    <div className="track-row">
      <div className="track-name" title={property}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {propertyLabel(property)}
        </span>
        <button
          type="button"
          title="Supprimer la piste"
          style={{ color: 'var(--text-2)', padding: '0 4px' }}
          onClick={() => removeTrack(property)}
        >
          ✕
        </button>
      </div>
      <div
        className="track-lane"
        ref={laneRef}
        onDoubleClick={(event) => {
          const rect = laneRef.current?.getBoundingClientRect();
          if (!rect || rect.width === 0) return;
          setTime(clamp((event.clientX - rect.left) / rect.width, 0, 1) * duration);
        }}
      >
        {sorted.slice(0, -1).map((keyframe, index) => {
          const next = sorted[index + 1]!;
          const left = toRatio(keyframe.time) * 100;
          const width = (toRatio(next.time) - toRatio(keyframe.time)) * 100;
          return (
            <div
              key={`link-${keyframe.id}`}
              className="kf-link"
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
        {sorted.map((keyframe) => (
          <div
            key={keyframe.id}
            className={`kf-dot${
              selected?.keyframeId === keyframe.id ? ' selected' : ''
            }`}
            style={{ left: `${toRatio(keyframe.time) * 100}%` }}
            title={`${keyframe.time.toFixed(3)}s · ${EASING_LABELS[keyframe.easing]}`}
            onPointerDown={(event) => startDrag(event, keyframe.id)}
          />
        ))}
      </div>
    </div>
  );
}
