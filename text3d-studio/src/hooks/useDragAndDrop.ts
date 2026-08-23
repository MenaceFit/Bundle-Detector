import { useEffect, useState } from 'react';
import { useStore } from '@/state/store';
import { importFontFile } from '@/fonts/fontManager';
import { deserializePreset } from '@/project/presetLibrary';
import { readJson, STORAGE_KEYS, writeJson } from '@/project/storage';
import type { StylePreset } from '@/types';
import type { ProjectIO } from './useProjectIO';

const FONT_EXTENSIONS = /\.(ttf|otf|woff2?)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;
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
          if (VIDEO_EXTENSIONS.test(file.name)) {
            // Electron exposes the real path, so the video is opened in place
            // rather than copied into memory.
            const filePath = window.desktop ? webUtilsPath(file) : null;
            if (!filePath) {
              notify('error', 'Le glisser-déposer vidéo nécessite l’application de bureau.');
              continue;
            }
            const { importVideo } = await import(
              '@/components/VideoCaptions/VideoCaptionsWorkspace'
            );
            useStore.getState().setWorkspace('captions');
            await importVideo(filePath, file.name);
            continue;
          }

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

/**
 * Absolute path of a dropped file.
 *
 * Electron used to expose `File.path`; newer versions moved it behind
 * `webUtils.getPathForFile`. Both are probed so the drop works across versions,
 * and the browser simply has neither.
 */
function webUtilsPath(file: File): string | null {
  const legacy = (file as File & { path?: string }).path;
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;
  const utils = (window as { webUtils?: { getPathForFile(file: File): string } }).webUtils;
  try {
    const resolved = utils?.getPathForFile(file);
    return resolved && resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}
