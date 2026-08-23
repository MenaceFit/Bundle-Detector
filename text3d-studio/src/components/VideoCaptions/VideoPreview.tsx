import { useEffect, useRef } from 'react';
import { useVideoStore } from '@/videoproject/store';
import { renderCaptionFrame } from '@/captions/renderer';
import { formatTimecode } from '@/utils/format';
import { createLogger } from '@/utils/logger';

const log = createLogger('video-preview');

/** Streams the source file from disk instead of buffering it into memory. */
export function mediaUrl(filePath: string): string {
  return `appmedia://local${filePath.startsWith('/') ? '' : '/'}${encodeURI(filePath)}`;
}

/**
 * Live preview: the real video element with the caption overlay drawn on a
 * canvas above it.
 *
 * The video element is the clock. Captions are drawn from `video.currentTime`
 * on every animation frame, so picture, sound and text can never drift apart —
 * which is the property that matters most in this feature.
 */
export function VideoPreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const metadata = useVideoStore((state) => state.metadata);
  const playing = useVideoStore((state) => state.playing);

  // Play/pause is driven by the store so the timeline controls stay in charge.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      void video.play().catch((error) => {
        log.warn('Lecture impossible', error);
        useVideoStore.getState().setPlaying(false);
      });
    } else {
      video.pause();
    }
  }, [playing]);

  // Seeking from the timeline or from a word click.
  useEffect(() => {
    const unsubscribe = useVideoStore.subscribe((state, previous) => {
      const video = videoRef.current;
      if (!video || state.time === previous.time) return;
      if (Math.abs(video.currentTime - state.time) > 0.06) {
        video.currentTime = state.time;
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let frame = 0;

    const draw = (): void => {
      frame = requestAnimationFrame(draw);
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const state = useVideoStore.getState();
      if (!video || !canvas || !state.metadata) return;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const targetW = Math.round(width * dpr);
      const targetH = Math.round(height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // The video element is the single source of truth for time.
      if (state.playing) {
        useVideoStore.setState({ time: video.currentTime });
      }

      try {
        renderCaptionFrame(ctx, {
          track: state.track,
          style: state.style,
          animation: state.animation,
          width: targetW,
          height: targetH,
          time: video.currentTime,
        });
      } catch (error) {
        log.error('Rendu des sous-titres impossible', error);
      }

      if (state.showSafeZones) drawSafeZones(ctx, targetW, targetH);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  if (!metadata) return null;

  const aspect = metadata.width / Math.max(1, metadata.height);

  return (
    <div className="vc-preview">
      <div className="vc-stage" style={{ aspectRatio: String(aspect) }}>
        <video
          ref={videoRef}
          src={mediaUrl(metadata.path)}
          onEnded={() => useVideoStore.getState().setPlaying(false)}
          onTimeUpdate={(event) => {
            if (!useVideoStore.getState().playing) return;
            useVideoStore.setState({ time: event.currentTarget.currentTime });
          }}
          playsInline
        />
        <canvas ref={canvasRef} className="vc-overlay" />
      </div>
      <PreviewBar />
    </div>
  );
}

function PreviewBar() {
  const time = useVideoStore((state) => state.time);
  const playing = useVideoStore((state) => state.playing);
  const metadata = useVideoStore((state) => state.metadata);
  const showSafeZones = useVideoStore((state) => state.showSafeZones);
  const setPlaying = useVideoStore((state) => state.setPlaying);
  const setTime = useVideoStore((state) => state.setTime);
  const toggleSafeZones = useVideoStore((state) => state.toggleSafeZones);
  const fps = useVideoStore((state) => state.output.fps);

  const duration = metadata?.durationSec ?? 0;

  return (
    <div className="canvas-bar">
      <button
        type="button"
        className="btn btn-icon"
        title="Retour au début"
        onClick={() => setTime(0)}
      >
        ↩
      </button>
      <button
        type="button"
        className="btn btn-icon"
        title="Image précédente"
        onClick={() => {
          setPlaying(false);
          setTime(time - 1 / Math.max(1, fps));
        }}
      >
        ⏮
      </button>
      <button
        type="button"
        className="btn btn-primary btn-icon"
        title="Lecture / Pause (Espace)"
        onClick={() => setPlaying(!playing)}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        className="btn btn-icon"
        title="Image suivante"
        onClick={() => {
          setPlaying(false);
          setTime(time + 1 / Math.max(1, fps));
        }}
      >
        ⏭
      </button>

      <span className="timecode">
        {formatTimecode(time)} / {formatTimecode(duration)}
      </span>

      <div style={{ flex: 1 }} />

      <button
        type="button"
        className={`btn btn-sm${showSafeZones ? ' active' : ''}`}
        onClick={toggleSafeZones}
        title="Afficher les zones masquées par l’interface des réseaux sociaux"
      >
        Safe zones
      </button>
    </div>
  );
}

/**
 * Regions the platform interface covers on a vertical video. Approximate by
 * nature — they are drawn as a guide, never baked into the export.
 */
function drawSafeZones(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 92, 92, 0.75)';
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = Math.max(1, width * 0.003);
  ctx.fillStyle = 'rgba(255, 92, 92, 0.10)';

  const top = height * 0.09;
  const bottom = height * 0.22;
  const right = width * 0.18;

  ctx.fillRect(0, 0, width, top);
  ctx.strokeRect(0, 0, width, top);
  ctx.fillRect(0, height - bottom, width, bottom);
  ctx.strokeRect(0, height - bottom, width, bottom);
  ctx.fillRect(width - right, top, right, height - top - bottom);
  ctx.strokeRect(width - right, top, right, height - top - bottom);

  ctx.restore();
}
