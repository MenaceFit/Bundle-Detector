import { useEffect, useMemo, useState } from 'react';
import { Section } from '../ui/Section';
import { useActiveLayer } from '@/state/hooks';
import { useStore } from '@/state/store';
import type { StylePreset } from '@/types';
import {
  deserializePreset,
  duplicatePreset,
  loadPresets,
  presetFromLayer,
  saveBuiltinFavorites,
  saveUserPresets,
  serializePreset,
} from '@/project/presetLibrary';
import { invalidateThumbnail, presetThumbnail } from './thumbnail';
import { downloadBlob, saveBlob } from '@/export/save';
import { sanitizeFileName } from '@/utils/format';
import { extractPalette } from '@/project/randomize';
import { createCanvas } from '@/engine/renderer/scratch';

export function PresetsPanel() {
  const layer = useActiveLayer();
  const applyStylePreset = useStore((state) => state.applyStylePreset);
  const applyRandomStyle = useStore((state) => state.applyRandomStyle);
  const notify = useStore((state) => state.notify);
  const referenceImage = useStore((state) => state.referenceImage);
  const setReferenceImage = useStore((state) => state.setReferenceImage);
  const patchLayerMany = useStore((state) => state.patchLayerMany);

  const [presets, setPresets] = useState<StylePreset[]>(() => loadPresets());
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [appliedId, setAppliedId] = useState<string | null>(null);

  useEffect(() => {
    saveUserPresets(presets);
    saveBuiltinFavorites(presets);
  }, [presets]);

  const visible = useMemo(
    () => (onlyFavorites ? presets.filter((preset) => preset.favorite) : presets),
    [presets, onlyFavorites],
  );

  const apply = (preset: StylePreset): void => {
    applyStylePreset(preset);
    setAppliedId(preset.id);
    notify('success', `Preset « ${preset.name} » appliqué`);
  };

  const savePreset = (): void => {
    const name = window.prompt('Nom du preset', `${layer.name} · style`);
    if (!name) return;
    const preset = presetFromLayer(layer, name.trim() || 'Sans nom');
    setPresets((list) => [...list, preset]);
    notify('success', 'Preset enregistré');
  };

  const rename = (preset: StylePreset): void => {
    const name = window.prompt('Nouveau nom', preset.name);
    if (!name) return;
    setPresets((list) => list.map((p) => (p.id === preset.id ? { ...p, name: name.trim() } : p)));
  };

  const remove = (preset: StylePreset): void => {
    if (preset.builtin) return;
    setPresets((list) => list.filter((p) => p.id !== preset.id));
    invalidateThumbnail(preset.id);
    notify('info', 'Preset supprimé');
  };

  const exportPreset = async (preset: StylePreset): Promise<void> => {
    const blob = new Blob([serializePreset(preset)], { type: 'application/json' });
    const name = `${sanitizeFileName(preset.name)}.preset.json`;
    if (window.desktop) {
      const result = await saveBlob(blob, name, ['json']);
      if (result) notify('success', 'Preset exporté');
    } else {
      downloadBlob(blob, name);
    }
  };

  const importPreset = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const preset = deserializePreset(await file.text());
        setPresets((list) => [...list, preset]);
        notify('success', `Preset « ${preset.name} » importé`);
      } catch (error) {
        notify('error', `Import impossible : ${(error as Error).message}`);
      }
    };
    input.click();
  };

  const importReference = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => setReferenceImage(String(reader.result));
      reader.readAsDataURL(file);
    };
    input.click();
  };

  /**
   * Reads the dominant colour of the reference image and rebuilds a matching
   * face / outline / extrusion palette. Everything runs locally on a canvas —
   * no AI service, and the analysis stays swappable behind this one call.
   */
  const applyReferenceColors = (): void => {
    if (!referenceImage) return;
    const image = new Image();
    image.onload = () => {
      try {
        const size = 96;
        const { canvas, ctx } = createCanvas(size, size);
        ctx.drawImage(image, 0, 0, size, size);
        const palette = extractPalette(ctx.getImageData(0, 0, size, size).data);
        canvas.width = 0;
        canvas.height = 0;

        if (!palette) {
          notify('error', 'Aucune couleur dominante exploitable dans cette image.');
          return;
        }

        patchLayerMany([
          ['style.fill.color', palette.face],
          ['style.fill.color2', palette.side],
          ['style.stroke.color', palette.outline],
          ['style.extrusion.color', palette.side],
          ['style.glow.color', palette.face],
        ]);
        notify('success', `Palette extraite (${palette.dominant})`);
      } catch (error) {
        notify('error', `Analyse impossible : ${(error as Error).message}`);
      }
    };
    image.onerror = () => notify('error', 'Image de référence illisible.');
    image.src = referenceImage;
  };

  return (
    <>
      <Section
        title="Presets de style"
        right={
          <span
            className={`btn btn-sm${onlyFavorites ? ' active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              setOnlyFavorites((v) => !v);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setOnlyFavorites((v) => !v);
            }}
          >
            ★
          </span>
        }
      >
        <div className="preset-grid">
          {visible.map((preset) => (
            <div key={preset.id} className={`preset-card${appliedId === preset.id ? ' active' : ''}`}>
              <button
                type="button"
                style={{ display: 'block', width: '100%' }}
                onClick={() => apply(preset)}
                title={`Appliquer « ${preset.name} »`}
              >
                <img
                  className="preset-thumb"
                  src={presetThumbnail(preset)}
                  alt={preset.name}
                  draggable={false}
                />
              </button>
              <div className="preset-name">
                <span
                  style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={preset.name}
                >
                  {preset.name}
                </span>
                <button
                  type="button"
                  className={`preset-star${preset.favorite ? ' on' : ''}`}
                  title="Favori"
                  onClick={() =>
                    setPresets((list) =>
                      list.map((p) => (p.id === preset.id ? { ...p, favorite: !p.favorite } : p)),
                    )
                  }
                >
                  {preset.favorite ? '★' : '☆'}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 2, padding: '0 5px 5px' }}>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  title="Dupliquer"
                  onClick={() => setPresets((list) => [...list, duplicatePreset(preset)])}
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  title="Exporter"
                  onClick={() => void exportPreset(preset)}
                >
                  ↧
                </button>
                {!preset.builtin && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      title="Renommer"
                      onClick={() => rename(preset)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost btn-danger"
                      title="Supprimer"
                      onClick={() => remove(preset)}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="field-row" style={{ marginTop: 4 }}>
          <button type="button" className="btn btn-sm" onClick={savePreset}>
            Enregistrer le style
          </button>
          <button type="button" className="btn btn-sm" onClick={importPreset}>
            Importer
          </button>
        </div>
      </Section>

      <Section title="Randomize">
        <p className="hint">
          Génère une variante cohérente : couleur, extrusion, angle, ombre, glow et rotation sont
          retirés au sort autour d’une teinte unique.
        </p>
        <div className="field-row">
          <button type="button" className="btn btn-primary" onClick={applyRandomStyle}>
            🎲 Randomize
          </button>
          <button type="button" className="btn" onClick={applyRandomStyle}>
            Regenerate
          </button>
        </div>
      </Section>

      <Section title="Image de référence" defaultOpen={false}>
        <p className="hint">
          Importez une image pour vous en inspirer. Elle sert uniquement de repère visuel et
          n’entre jamais dans le rendu ni dans l’export.
        </p>
        {referenceImage && (
          <img className="reference-image" src={referenceImage} alt="Référence" />
        )}
        <div className="field-row">
          <button type="button" className="btn btn-sm" onClick={importReference}>
            Import Reference
          </button>
          {referenceImage && (
            <>
              <button type="button" className="btn btn-sm" onClick={applyReferenceColors}>
                Extraire la palette
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => setReferenceImage(null)}
              >
                Retirer
              </button>
            </>
          )}
        </div>
      </Section>
    </>
  );
}
