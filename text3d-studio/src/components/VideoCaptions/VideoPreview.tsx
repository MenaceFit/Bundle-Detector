import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVideoStore } from '@/videoproject/store';
import { renderCaptionFrame } from '@/captions/renderer';
import { buildPreviewProxy } from '@/videoproject/pipeline';
import { humanizeError } from '@/videoproject/errors';
import {
  containFit,
  mediaUrl,
  probeNativePlayback,
  unsupportedReason,
} from '@/videoproject/playback';
import type { VideoMetadata } from '@/captions/types';
import { formatTimecode } from '@/utils/format';
import { createLogger } from '@/utils/logger';

const log = createLogger('video-preview');

/**
 * How long a source may go without producing a picture before it is declared
 * unplayable.
 *
 * The failure this catches is worse than an error. Measured on an HEVC file in
 * this Electron build: the element loads, reports a duration, and `currentTime`
 * advances normally — but `videoWidth` stays 0 and not a single frame is ever
 * decoded. No `error` event is fired, so nothing but a check on the picture
 * itself can tell the difference between that and a working video.
 */
const LOAD_TIMEOUT_MS = 6000;

/**
 * Live preview: the real video element with the caption overlay drawn on a
 * canvas above it.
 *
 * The video element is the clock. Captions are drawn from `video.currentTime`
 * on every animation frame, so picture, sound and text can never drift apart —
 * which is the property that matters most in this feature.
 *
 * Getting a *picture* at all is the other half of the job. Two things used to
 * prevent it: the stage was sized from the video's intrinsic dimensions, so it
 * collapsed to nothing while the file was loading, and a source the browser
 * engine cannot decode (HEVC, ProRes, MKV…) left the element silently empty.
 * The stage is now measured from its container, and an undecodable source is
 * transcoded once into a cached proxy.
 */
export function VideoPreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const metadata = useVideoStore((state) => state.metadata);
  const playing = useVideoStore((state) => state.playing);
  const preview = useVideoStore((state) => state.preview);

  const aspect = metadata ? metadata.width / Math.max(1, metadata.height) : 16 / 9;
  const stage = useStageSize(frameRef, aspect);
  const source = preview.status === 'ready' && preview.path ? mediaUrl(preview.path) : undefined;

  useSourceResolution(metadata);

  /**
   * Falls back to the transcoded proxy when the original turns out to be
   * unplayable after all — the codec check is a prediction, this is the proof.
   */
  const fallbackToProxy = useCallback(
    (reason: string) => {
      const state = useVideoStore.getState();
      if (!state.metadata || state.preview.status === 'preparing') return;
      state.setPlaying(false);
      if (state.preview.source === 'proxy') {
        // The converted copy failed too: there is nothing left to fall back to,
        // so say so rather than looping on the same conversion.
        log.error('Le proxy d’aperçu est lui aussi illisible', reason);
        state.setPreview({
          status: 'error',
          message: `Aperçu impossible (${reason}). L’export reste utilisable : il passe par FFmpeg, pas par le lecteur.`,
        });
        return;
      }
      log.warn('Source illisible par le lecteur, passage au proxy', reason);
      void prepareProxy(state.metadata, reason);
    },
    [],
  );

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
  }, [playing, source]);

  // Seeking from the timeline or from a word click. A seek requested before the
  // file has any metadata is remembered and replayed once it does.
  const pendingSeek = useRef<number | null>(null);
  useEffect(() => {
    const unsubscribe = useVideoStore.subscribe((state, previous) => {
      const video = videoRef.current;
      if (!video || state.time === previous.time) return;
      if (video.readyState === 0) {
        pendingSeek.current = state.time;
        return;
      }
      if (Math.abs(video.currentTime - state.time) > 0.06) {
        video.currentTime = state.time;
      }
    });
    return unsubscribe;
  }, []);

  // Watchdog: a source that produces no picture gets one proxy attempt.
  useEffect(() => {
    if (!source) return;
    const timer = window.setTimeout(() => {
      const video = videoRef.current;
      if (!video) return;
      if (video.videoWidth === 0) {
        const seconds = Math.round(LOAD_TIMEOUT_MS / 1000);
        fallbackToProxy(
          video.readyState === 0
            ? `aucune donnée après ${seconds} s`
            : `aucune image décodée après ${seconds} s`,
        );
      }
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [source, fallbackToProxy]);

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

      // The video element is the single source of truth for time — but only
      // once it actually holds a timeline; before that the store leads.
      const usable = video.readyState > 0;
      const time = usable ? video.currentTime : state.time;
      if (state.playing && usable) {
        useVideoStore.setState({ time });
      }

      try {
        renderCaptionFrame(ctx, {
          track: state.track,
          style: state.style,
          animation: state.animation,
          width: targetW,
          height: targetH,
          time,
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

  return (
    <div className="vc-preview">
      <div className="vc-frame" ref={frameRef}>
        <div
          className="vc-stage"
          style={{ width: `${stage.width}px`, height: `${stage.height}px` }}
        >
          <video
            ref={videoRef}
            key={source ?? 'none'}
            src={source}
            preload="auto"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              const seek = pendingSeek.current ?? useVideoStore.getState().time;
              pendingSeek.current = null;
              if (seek > 0 && Number.isFinite(video.duration)) {
                video.currentTime = Math.min(seek, video.duration);
              }
            }}
            onEnded={() => useVideoStore.getState().setPlaying(false)}
            onError={() => {
              const code = videoRef.current?.error?.code ?? 0;
              fallbackToProxy(`erreur de décodage (${code})`);
            }}
            onTimeUpdate={(event) => {
              if (!useVideoStore.getState().playing) return;
              useVideoStore.setState({ time: event.currentTarget.currentTime });
            }}
            playsInline
          />
          <canvas ref={canvasRef} className="vc-overlay" />
          <PreviewStatus />
        </div>
      </div>
      <PreviewBar />
    </div>
  );
}

/**
 * Sizes the stage from the space available rather than from the video.
 *
 * The previous layout let CSS derive the stage's width from the `<video>`
 * intrinsic size, which is zero until the file loads — so a source that failed
 * to load produced a zero-sized stage, an overlay canvas of zero pixels, and
 * nothing on screen whatsoever.
 */
function useStageSize(
  ref: React.RefObject<HTMLDivElement | null>,
  aspect: number,
): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setBox({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    const rect = element.getBoundingClientRect();
    setBox({ width: rect.width, height: rect.height });
    return () => observer.disconnect();
  }, [ref]);

  return containFit(box.width, box.height, aspect);
}

/**
 * Decides, once per imported file, what the player should point at.
 *
 * A source the engine reports as playable is used directly; anything else is
 * converted first, so the preview never depends on the user having the right
 * codecs installed.
 */
function useSourceResolution(metadata: VideoMetadata | null): void {
  useEffect(() => {
    if (!metadata) return;
    const state = useVideoStore.getState();
    if (state.preview.status !== 'idle') return;

    if (probeNativePlayback(metadata) !== 'no') {
      state.setPreview({
        path: metadata.path,
        source: 'original',
        status: 'ready',
        message: '',
      });
      return;
    }
    void prepareProxy(metadata, unsupportedReason(metadata));
  }, [metadata]);
}

/** Builds the cached H.264 proxy and points the player at it. */
async function prepareProxy(metadata: VideoMetadata, reason: string): Promise<void> {
  const store = useVideoStore.getState();
  store.setPreview({
    path: null,
    source: 'proxy',
    status: 'preparing',
    message: `Préparation de l’aperçu : ${reason}. Conversion locale en cours…`,
  });
  try {
    const proxyPath = await buildPreviewProxy(metadata);
    // The import may have been replaced while ffmpeg was working.
    if (useVideoStore.getState().metadata?.path !== metadata.path) return;
    useVideoStore.getState().setPreview({
      path: proxyPath,
      source: 'proxy',
      status: 'ready',
      message: '',
    });
  } catch (error) {
    log.error('Proxy d’aperçu impossible', error);
    if (useVideoStore.getState().metadata?.path !== metadata.path) return;
    useVideoStore.getState().setPreview({
      status: 'error',
      message: `Aperçu indisponible : ${humanizeError(error)}`,
    });
  }
}

/** Banner shown over the stage while the preview is not playable. */
function PreviewStatus() {
  const preview = useVideoStore((state) => state.preview);
  const metadata = useVideoStore((state) => state.metadata);
  if (preview.status === 'ready') return null;

  return (
    <div className={`vc-stage-status${preview.status === 'error' ? ' is-error' : ''}`}>
      {preview.status === 'preparing' && <div className="vc-spinner" aria-hidden="true" />}
      <p>{preview.message || 'Analyse de la vidéo…'}</p>
      {preview.status === 'error' && metadata && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void prepareProxy(metadata, 'nouvelle tentative')}
        >
          Réessayer
        </button>
      )}
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
  const preview = useVideoStore((state) => state.preview);

  const duration = metadata?.durationSec ?? 0;
  // Nothing to play until the player has a source it can actually open.
  const ready = preview.status === 'ready';

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
        title={ready ? 'Lecture / Pause (Espace)' : 'Aperçu en cours de préparation'}
        disabled={!ready}
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
