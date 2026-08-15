import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/state/store';
import { renderProject, layoutForLayer, layerBounds } from '@/engine/renderer';
import { createCanvas, type Scratch } from '@/engine/renderer/scratch';
import { formatTimecode } from '@/utils/format';
import { clamp } from '@/utils/math';
import type { PreviewSettings } from '@/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('canvas');

/** Rendering above this many device pixels is throttled to keep the UI live. */
const PREVIEW_PIXEL_BUDGET = 4_500_000;

export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<Scratch | null>(null);
  const dirtyRef = useRef(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [panning, setPanning] = useState(false);

  const canvasWidth = useStore((state) => state.project.canvas.width);
  const canvasHeight = useStore((state) => state.project.canvas.height);
  const zoom = useStore((state) => state.zoom);
  const panX = useStore((state) => state.panX);
  const panY = useStore((state) => state.panY);

  /* --------------------------------------------------------- rendering */

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const state = useStore.getState();
    const { project } = state;
    const dpr = window.devicePixelRatio || 1;

    // Supersample for crispness, but never beyond the pixel budget.
    const requested = project.canvas.width * project.canvas.height * state.zoom * state.zoom * dpr * dpr;
    const throttle = requested > PREVIEW_PIXEL_BUDGET ? Math.sqrt(PREVIEW_PIXEL_BUDGET / requested) : 1;
    const scale = state.zoom * dpr * throttle;

    const width = Math.max(1, Math.round(project.canvas.width * scale));
    const height = Math.max(1, Math.round(project.canvas.height * scale));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.style.width = `${project.canvas.width * state.zoom}px`;
    canvas.style.height = `${project.canvas.height * state.zoom}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let content = contentRef.current;
    if (!content || content.canvas.width !== width || content.canvas.height !== height) {
      content = createCanvas(width, height);
      contentRef.current = content;
    }

    try {
      // Content is rendered on its own surface: the preview background and the
      // overlays below can never end up in an export.
      renderProject(content.ctx, project, state.time, {
        scale,
        background: null,
        quality: 'preview',
      });
    } catch (error) {
      log.error('Rendu impossible', error);
      return;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawPreviewBackground(ctx, project.canvas.preview, width, height, scale);
    ctx.drawImage(content.canvas, 0, 0);
    drawOverlays(ctx, width, height, scale);
  }, []);

  useEffect(() => {
    const unsubscribe = useStore.subscribe(() => {
      dirtyRef.current = true;
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();

    const loop = (now: number): void => {
      const delta = (now - last) / 1000;
      last = now;

      const state = useStore.getState();
      if (state.playing) {
        const { duration, loop: looping } = state.project.timeline;
        let next = state.time + delta;
        if (next >= duration) {
          if (looping) {
            next = duration > 0 ? next % duration : 0;
          } else {
            next = duration;
            useStore.setState({ playing: false });
          }
        }
        useStore.setState({ time: next });
        dirtyRef.current = true;
      }

      if (dirtyRef.current) {
        dirtyRef.current = false;
        draw();
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [draw]);

  // Device pixel ratio can change when the window moves between screens.
  useEffect(() => {
    const onResize = (): void => {
      dirtyRef.current = true;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* ------------------------------------------------------- interaction */

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      // Plain wheel pans vertically, like most canvas editors.
      useStore.getState().setPan(panX - event.deltaX, panY - event.deltaY);
      return;
    }
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    useStore.getState().zoomBy(factor);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const isPanGesture = event.button === 1 || event.button === 2 || event.shiftKey;
    if (!isPanGesture) return;
    event.preventDefault();
    setPanning(true);
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = panX;
    const originY = panY;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent): void => {
      useStore
        .getState()
        .setPan(originX + (moveEvent.clientX - startX), originY + (moveEvent.clientY - startY));
    };
    const onUp = (): void => {
      setPanning(false);
      target.releasePointerCapture(event.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** Fits the composition inside the viewport. */
  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const state = useStore.getState();
    const next = Math.min(
      (rect.width - 64) / state.project.canvas.width,
      (rect.height - 64) / state.project.canvas.height,
    );
    state.setZoom(clamp(next, 0.05, 8));
    state.setPan(0, 0);
  }, []);

  useEffect(() => {
    fitToView();
  }, [fitToView]);

  return (
    <div className="canvas-area">
      <div
        className={`canvas-viewport${panning ? ' panning' : ''}`}
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="canvas-stage" style={{ transform: `translate(${panX}px, ${panY}px)` }}>
          <canvas ref={canvasRef} />
        </div>
      </div>
      <CanvasBar
        onFit={fitToView}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        zoom={zoom}
      />
    </div>
  );
}

/* ----------------------------------------------------------- decorations */

function drawPreviewBackground(
  ctx: CanvasRenderingContext2D,
  preview: PreviewSettings,
  width: number,
  height: number,
  scale: number,
): void {
  if (preview.kind === 'transparent') return;

  if (preview.kind === 'checkerboard') {
    const size = Math.max(6, 12 * scale);
    ctx.fillStyle = '#20242e';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#171b23';
    for (let y = 0; y < height; y += size) {
      for (let x = 0; x < width; x += size) {
        if (((x / size) | 0) % 2 === ((y / size) | 0) % 2) continue;
        ctx.fillRect(x, y, size, size);
      }
    }
    return;
  }

  ctx.fillStyle =
    preview.kind === 'white' ? '#ffffff' : preview.kind === 'black' ? '#000000' : preview.customColor;
  ctx.fillRect(0, 0, width, height);
}

function drawOverlays(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scale: number,
): void {
  const state = useStore.getState();
  const preview = state.project.canvas.preview;

  ctx.save();

  if (preview.showGrid) {
    const step = Math.max(4, preview.gridSize * scale);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = step; x < width; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
    }
    for (let y = step; y < height; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  if (preview.showGuides) {
    ctx.strokeStyle = 'rgba(76,154,255,0.4)';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    for (const ratio of [1 / 3, 2 / 3]) {
      ctx.moveTo(Math.round(width * ratio) + 0.5, 0);
      ctx.lineTo(Math.round(width * ratio) + 0.5, height);
      ctx.moveTo(0, Math.round(height * ratio) + 0.5);
      ctx.lineTo(width, Math.round(height * ratio) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (preview.showCenter) {
    ctx.strokeStyle = 'rgba(255,212,0,0.5)';
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  }

  if (preview.showBounds) {
    const layer = state.project.layers.find((l) => l.id === state.project.activeLayerId);
    if (layer) {
      const bounds = layerBounds(layer, layoutForLayer(layer));
      ctx.strokeStyle = 'rgba(255,212,0,0.85)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(
        (state.project.canvas.width / 2 + bounds.x) * scale,
        (state.project.canvas.height / 2 + bounds.y) * scale,
        bounds.width * scale,
        bounds.height * scale,
      );
      ctx.setLineDash([]);
    }
  }

  ctx.restore();
}

/* ------------------------------------------------------------ bottom bar */

function CanvasBar({
  onFit,
  canvasWidth,
  canvasHeight,
  zoom,
}: {
  onFit: () => void;
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
}) {
  const time = useStore((state) => state.time);
  const duration = useStore((state) => state.project.timeline.duration);
  const preview = useStore((state) => state.project.canvas.preview);
  const updatePreview = useStore((state) => state.updatePreview);
  const zoomBy = useStore((state) => state.zoomBy);
  const resetView = useStore((state) => state.resetView);

  const toggles: Array<[keyof typeof preview, string, string]> = [
    ['showGrid', '#', 'Grille'],
    ['showGuides', '⌗', 'Guides'],
    ['showBounds', '⬚', 'Limites du texte'],
    ['showCenter', '✛', 'Centre'],
  ];

  return (
    <div className="canvas-bar">
      <span className="timecode">
        {formatTimecode(time)} / {formatTimecode(duration)}
      </span>

      <span className="chip">
        {canvasWidth} × {canvasHeight}
      </span>

      <div style={{ flex: 1 }} />

      {toggles.map(([key, icon, title]) => (
        <button
          key={key}
          type="button"
          className={`btn btn-icon btn-sm${preview[key] ? ' active' : ''}`}
          title={title}
          onClick={() => updatePreview({ [key]: !preview[key] })}
        >
          {icon}
        </button>
      ))}

      <select
        className="input"
        style={{ width: 128 }}
        value={preview.kind}
        onChange={(event) => updatePreview({ kind: event.target.value as PreviewSettings['kind'] })}
        title="Fond de prévisualisation (jamais exporté)"
      >
        <option value="checkerboard">Damier</option>
        <option value="transparent">Transparent</option>
        <option value="white">Blanc</option>
        <option value="black">Noir</option>
        <option value="custom">Personnalisé</option>
      </select>

      <button type="button" className="btn btn-icon btn-sm" title="Dézoomer" onClick={() => zoomBy(1 / 1.2)}>
        −
      </button>
      <span className="chip" style={{ minWidth: 46, textAlign: 'center' }}>
        {Math.round(zoom * 100)}%
      </span>
      <button type="button" className="btn btn-icon btn-sm" title="Zoomer" onClick={() => zoomBy(1.2)}>
        +
      </button>
      <button type="button" className="btn btn-sm" onClick={onFit} title="Ajuster à la fenêtre">
        Ajuster
      </button>
      <button type="button" className="btn btn-sm" onClick={resetView} title="Zoom 100 %">
        100 %
      </button>
    </div>
  );
}
