import { useMemo, useRef, useState } from 'react';
import { useStore } from '@/state/store';
import { estimateSize, runExport, type ExportProgress } from '@/export';
import { formatBytes } from '@/utils/format';
import { NumberControl, SelectControl, Segmented } from '../ui/Controls';
import { ColorSwatch } from '../ColorPicker/ColorField';
import { Field } from '../ui/Field';
import type { ExportFormat, ExportQuality } from '@/types';
import { pickWebmMimeType, supportsTransparentWebm } from '@/export/webm';

const RESOLUTIONS: Array<[string, number, number]> = [
  ['512 × 512', 512, 512],
  ['1024 × 1024', 1024, 1024],
  ['2048 × 2048', 2048, 2048],
  ['4096 × 4096', 4096, 4096],
  ['1920 × 1080', 1920, 1080],
  ['1080 × 1920', 1080, 1920],
];

export function ExportDialog() {
  const open = useStore((state) => state.exportOpen);
  const setOpen = useStore((state) => state.setExportOpen);
  const project = useStore((state) => state.project);
  const settings = useStore((state) => state.project.exportSettings);
  const setExportSettings = useStore((state) => state.setExportSettings);
  const time = useStore((state) => state.time);
  const notify = useStore((state) => state.notify);

  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isAnimation = settings.format !== 'png' && settings.format !== 'webp';
  const duration = settings.duration ?? project.timeline.duration;
  const estimate = useMemo(() => estimateSize(project, settings), [project, settings]);

  const webmMime = useMemo(() => (settings.format === 'webm' ? pickWebmMimeType() : null), [settings.format]);
  const webmAlphaWarning =
    settings.format === 'webm' && settings.transparent && webmMime !== null && !supportsTransparentWebm(webmMime);

  if (!open) return null;

  const start = async (): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ phase: 'Préparation', ratio: 0 });

    try {
      const result = await runExport(project, settings, time, {
        onProgress: setProgress,
        signal: controller.signal,
      });
      if (result) {
        notify('success', `Export terminé : ${result.fileName} (${formatBytes(result.size)})`);
        setOpen(false);
      } else {
        notify('info', 'Export annulé');
      }
    } catch (error) {
      notify('error', `Erreur d’export : ${(error as Error).message}`);
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  const busy = progress !== null;

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && setOpen(false)}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          Export
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <Field label="Format">
            <SelectControl<ExportFormat>
              value={settings.format}
              onChange={(format) => setExportSettings({ format })}
              options={[
                { value: 'png', label: 'PNG (transparent)' },
                { value: 'webp', label: 'WebP' },
                { value: 'webm', label: 'WebM (vidéo)' },
                { value: 'gif', label: 'GIF animé' },
                { value: 'sequence', label: 'Séquence PNG' },
              ]}
            />
          </Field>

          <Field label="Résolution" value={`${settings.width} × ${settings.height}`}>
            <div className="anim-list" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {RESOLUTIONS.map(([label, width, height]) => (
                <button
                  key={label}
                  type="button"
                  className={`anim-btn${
                    settings.width === width && settings.height === height ? ' active' : ''
                  }`}
                  style={{ textAlign: 'center' }}
                  onClick={() => setExportSettings({ width, height })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="field-row" style={{ marginTop: 6 }}>
              <span className="hint">Custom</span>
              <NumberControl
                value={settings.width}
                onChange={(width) => setExportSettings({ width: Math.round(width) })}
                min={16}
                max={8192}
                decimals={0}
              />
              <span className="hint">×</span>
              <NumberControl
                value={settings.height}
                onChange={(height) => setExportSettings({ height: Math.round(height) })}
                min={16}
                max={8192}
                decimals={0}
              />
            </div>
          </Field>

          {isAnimation && (
            <>
              <Field label="Images par seconde">
                <Segmented
                  value={String(settings.fps)}
                  options={[
                    { value: '12', label: '12' },
                    { value: '24', label: '24' },
                    { value: '30', label: '30' },
                    { value: '60', label: '60' },
                  ]}
                  onChange={(value) => setExportSettings({ fps: Number(value) })}
                />
              </Field>

              <Field label="Durée" value={`${duration.toFixed(1)} s`}>
                <div className="field-row">
                  <NumberControl
                    value={duration}
                    onChange={(value) => setExportSettings({ duration: value })}
                    min={0.1}
                    max={120}
                    step={0.1}
                    decimals={1}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setExportSettings({ duration: null })}
                  >
                    Durée du projet
                  </button>
                </div>
              </Field>
            </>
          )}

          {settings.format === 'gif' && (
            <Field label="Couleurs de la palette" value={String(settings.gifColors)}>
              <input
                className="slider"
                type="range"
                min={8}
                max={255}
                step={1}
                value={settings.gifColors}
                onChange={(event) => setExportSettings({ gifColors: Number(event.target.value) })}
              />
            </Field>
          )}

          <Field label="Fond">
            <div className="field-row">
              <Segmented
                value={settings.transparent ? 'transparent' : 'color'}
                options={[
                  { value: 'transparent', label: 'Transparent' },
                  { value: 'color', label: 'Couleur' },
                ]}
                onChange={(value) => setExportSettings({ transparent: value === 'transparent' })}
              />
              {!settings.transparent && (
                <ColorSwatch
                  value={settings.backgroundColor}
                  onChange={(backgroundColor) => setExportSettings({ backgroundColor })}
                />
              )}
            </div>
            <p className="hint">
              Le damier de prévisualisation n’est jamais exporté : en mode transparent le fichier
              contient uniquement le texte et ses effets, avec un canal alpha à 0 partout ailleurs.
            </p>
            {webmAlphaWarning && (
              <p className="hint" style={{ color: 'var(--danger)' }}>
                Le codec WebM disponible ici ne conserve pas la transparence.
              </p>
            )}
          </Field>

          <Field label="Qualité">
            <Segmented
              value={settings.quality}
              options={[
                { value: 'low', label: 'Basse' },
                { value: 'medium', label: 'Moyenne' },
                { value: 'high', label: 'Haute' },
                { value: 'max', label: 'Max' },
              ]}
              onChange={(quality) => setExportSettings({ quality: quality as ExportQuality })}
            />
          </Field>

          {isAnimation && settings.format !== 'sequence' && (
            <div className="field-head">
              <span className="field-label">Boucle</span>
              <button
                type="button"
                className={`switch${settings.loop ? ' on' : ''}`}
                onClick={() => setExportSettings({ loop: !settings.loop })}
              />
            </div>
          )}

          <div className="chip" style={{ alignSelf: 'flex-start' }}>
            Poids estimé : {formatBytes(estimate)}
          </div>

          {progress && (
            <div>
              <div className="hint" style={{ marginBottom: 4 }}>
                {progress.phase} — {Math.round(progress.ratio * 100)} %
              </div>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${progress.ratio * 100}%` }} />
              </div>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          {busy ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => abortRef.current?.abort()}
            >
              Annuler
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Fermer
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void start()}>
                EXPORT
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
