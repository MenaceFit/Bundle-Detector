import { useEffect, useState } from 'react';
import { useStore } from '@/state/store';
import { importFontFile } from '@/fonts/fontManager';
import { deserializePreset } from '@/project/presetLibrary';
import { readJson, STORAGE_KEYS, writeJson } from '@/project/storage';
import type { StylePreset } from '@/types';
import type { ProjectIO } from './useProjectIO';

const FONT_EXTENSIONS = /\.(ttf|otf|woff2?)$/i;
const IMAGE_TYPES = /^image\//;

/**
 * Whole-window drop target: projects, presets, fonts and reference images are
 * routed by extension and content, so the user can drag anything relevant onto
 * the app.
 */
export function useDragAndDrop(io: ProjectIO): boolean {
  const [over, setOver] = useState(false);
  const notify = useStore((state) => state.notify);
  const setReferenceImage = useStore((state) => state.setReferenceImage);
  const applyStylePreset = useStore((state) => state.applyStylePreset);

  useEffect(() => {
    let depth = 0;

    const onDragEnter = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      depth += 1;
      setOver(true);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };

    const onDrop = async (event: DragEvent): Promise<void> => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      depth = 0;
      setOver(false);

      for (const file of [...event.dataTransfer.files]) {
        try {
          if (FONT_EXTENSIONS.test(file.name)) {
            const family = await importFontFile(file);
            if (family) notify('success', `Police importée : ${family}`);
            else notify('error', `Police invalide : ${file.name}`);
            continue;
          }

          if (IMAGE_TYPES.test(file.type)) {
            const reader = new FileReader();
            reader.onload = () => setReferenceImage(String(reader.result));
            reader.readAsDataURL(file);
            notify('info', 'Image de référence importée');
            continue;
          }

          if (file.name.endsWith('.json')) {
            const text = await file.text();
            if (file.name.includes('.preset')) {
              const preset = deserializePreset(text);
              const stored = readJson<StylePreset[]>(STORAGE_KEYS.userPresets, []);
              writeJson(STORAGE_KEYS.userPresets, [...stored, preset]);
              applyStylePreset(preset);
              notify('success', `Preset « ${preset.name} » importé et appliqué`);
            } else {
              await io.loadFromFile(file);
            }
            continue;
          }

          notify('error', `Type de fichier non pris en charge : ${file.name}`);
        } catch (error) {
          notify('error', `Import impossible (${file.name}) : ${(error as Error).message}`);
        }
      }
    };

    const onDropSync = (event: DragEvent): void => {
      void onDrop(event);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDropSync);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDropSync);
    };
  }, [applyStylePreset, io, notify, setReferenceImage]);

  return over;
}
