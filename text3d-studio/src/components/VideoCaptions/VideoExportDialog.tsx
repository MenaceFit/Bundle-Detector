import { useMemo, useRef, useState } from 'react';
import { Field } from '../ui/Field';
import { NumberControl, Segmented, SelectControl } from '../ui/Controls';
import { useVideoStore } from '@/videoproject/store';
import { renderSubtitles, type SubtitleFormat } from '@/captions/subtitles';
import { exportVideoWithCaptions, pickOutputPath } from '@/videoproject/pipeline';
import { QUALITY_PRESETS, type FitMode } from '@/ffmpeg';
import { saveBlob } from '@/export/save';
import { sanitizeFileName } from '@/utils/format';
import { useStore } from '@/state/store';
import { humanizeError } from '@/videoproject/errors';

const RESOLUTIONS: Array<[string, number, number]> = [
  ['1080 × 1920', 1080, 1920],
  ['1440 × 2560', 1440, 2560],
  ['2160 × 3840', 2160, 3840],
  ['1080 × 1080', 1080, 1080],
  ['1920 × 1080', 1920, 1080],
];

export function VideoExportDialog({ onClose }: { onClose: () => void }) {
  const metadata = useVideoStore((state) => state.metadata);
  const track = useVideoStore((state) => state.track);
  const style = useVideoStore((state) => state.style);
  const animation = useVideoStore((state) => state.animation);
  const transcript = useVideoStore((state) => state.transcript);
  const output = useVideoStore((state) => state.output);
  const setOutput = useVideoStore((state) => state.setOutput);
  const job = useVideoStore((state) => state.exportJob);
  const setExportJob = useVideoStore((state) => state.setExportJob);
  const notify = useStore((state) => state.notify);
  const abortRef = useRef<AbortController | null>(null);

  const [subtitleFormat, setSubtitleFormat] = useState<SubtitleFormat>('srt');

  const baseName = useMemo(
    () => sanitizeFileName(metadata?.fileName.replace(/\.[^.]+$/, '') ?? 'video'),
    [metadata],
  );

  if (!metadata) return null;

  const frames = Math.round(metadata.durationSec * output.fps);

  const startExport = async (): Promise<void> => {
    const target = await pickOutputPath(`${baseName}-captions.mp4`);
    if (!target) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setExportJob({ running: true, label: 'Préparation', ratio: 0, error: null });

    try {
      const result = await exportVideoWithCaptions({
        metadata,
        track,
        style,
        animation,
        width: output.width,
        height: output.height,
        fps: output.fps,
        fit: output.fit,
        encode: QUALITY_PRESETS[output.quality]!,
        outputPath: target,
        signal: controller.signal,
        onProgress: (ratio, label) => setExportJob({ ratio, label }),
      });
      setExportJob({ running: false, ratio: 1, label: 'Terminé', error: null });
      notify('success', `Vidéo exportée : ${result.outputPath}`);
      onClose();
    } catch (error) {
      const message = humanizeError(error);
      setExportJob({ running: false, ratio: null, label: '', error: message });
      notify('error', `Export impossible : ${message}`);
    } finally {
      abortRef.current = null;
    }
  };

  const exportSubtitles = async (): Promise<void> => {
    const content = renderSubtitles(
      subtitleFormat,
      track,
      style,
      { width: output.width, height: output.height },
      transcript,
    );
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const result = await saveBlob(blob, `${baseName}.${subtitleFormat}`, [subtitleFormat]);
    if (result) notify('success', `Sous-titres exportés (${subtitleFormat.toUpperCase()})`);
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !job.running && onClose()}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          Export vidéo
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onClose}
            disabled={job.running}
          >
            ✕
          </button>
        </header>

        <div className="modal-body">
          <Field label="Résolution" value={`${output.width} × ${output.height}`}>
            <div className="anim-list" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {RESOLUTIONS.map(([label, width, height]) => (
                <button
                  key={label}
                  type="button"
                  className={`anim-btn${
                    output.width === width && output.height === height ? ' active' : ''
                  }`}
                  style={{ textAlign: 'center' }}
                  onClick={() => setOutput({ width, height })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="field-row" style={{ marginTop: 6 }}>
              <span className="hint">Custom</span>
              <NumberControl
                value={output.width}
                onChange={(width) => setOutput({ width: Math.round(width) })}
                min={64}
                max={4096}
                decimals={0}
              />
              <span className="hint">×</span>
              <NumberControl
                value={output.height}
                onChange={(height) => setOutput({ height: Math.round(height) })}
                min={64}
                max={4096}
                decimals={0}
              />
            </div>
          </Field>

          <Field label="Cadrage" hint="Comment la source est placée dans le format de sortie">
            <SelectControl<FitMode>
              value={output.fit}
              onChange={(fit) => setOutput({ fit })}
              options={[
                { value: 'crop', label: 'Recadrer pour remplir' },
                { value: 'blur', label: 'Fond flouté (vidéo centrée)' },
                { value: 'fit', label: 'Contenir (bandes noires)' },
                { value: 'stretch', label: 'Étirer' },
              ]}
            />
          </Field>

          <Field label="Images par seconde">
            <Segmented
              value={String(output.fps)}
              options={[
                { value: '24', label: '24' },
                { value: '25', label: '25' },
                { value: '30', label: '30' },
                { value: '60', label: '60' },
              ]}
              onChange={(value) => setOutput({ fps: Number(value) })}
            />
          </Field>

          <Field label="Qualité">
            <Segmented
              value={output.quality}
              options={[
                { value: 'small', label: 'Léger' },
                { value: 'social', label: 'Réseaux' },
                { value: 'high', label: 'Haute' },
                { value: 'maximum', label: 'Maximale' },
              ]}
              onChange={(quality) => setOutput({ quality: quality as typeof output.quality })}
            />
            <p className="hint">
              {QUALITY_PRESETS[output.quality]!.copyAudio
                ? "L'audio d'origine est copié tel quel, sans réencodage."
                : "L'audio est réencodé en AAC pour réduire le poids."}
            </p>
          </Field>

          <div className="chip" style={{ alignSelf: 'flex-start' }}>
            {frames} images · {metadata.durationSec.toFixed(1)} s
          </div>

          {job.running && (
            <div>
              <div className="hint" style={{ marginBottom: 4 }}>
                {job.label} — {job.ratio === null ? '…' : `${Math.round(job.ratio * 100)} %`}
              </div>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${(job.ratio ?? 0) * 100}%` }} />
              </div>
            </div>
          )}

          {job.error && <p className="hint" style={{ color: 'var(--danger)' }}>{job.error}</p>}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <Field label="Sous-titres seuls">
              <div className="field-row">
                <SelectControl<SubtitleFormat>
                  value={subtitleFormat}
                  onChange={setSubtitleFormat}
                  options={[
                    { value: 'srt', label: 'SRT' },
                    { value: 'vtt', label: 'WebVTT' },
                    { value: 'ass', label: 'ASS (styles conservés)' },
                    { value: 'json', label: 'JSON (timings mot par mot)' },
                  ]}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void exportSubtitles()}
                  disabled={track.cues.length === 0}
                >
                  Exporter
                </button>
              </div>
            </Field>
          </div>
        </div>

        <footer className="modal-footer">
          {job.running ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => abortRef.current?.abort()}
            >
              Annuler
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Fermer
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void startExport()}
                disabled={track.cues.length === 0}
              >
                EXPORTER LA VIDÉO
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
