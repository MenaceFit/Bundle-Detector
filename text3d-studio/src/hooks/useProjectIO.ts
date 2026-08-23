import { useCallback } from 'react';
import { useStore } from '@/state/store';
import { serializeProject } from '@/project/serialize';
import { downloadBlob } from '@/export/save';
import { sanitizeFileName } from '@/utils/format';
import { createLogger } from '@/utils/logger';
import { useVideoStore } from '@/videoproject/store';
import { deserializeVideoProject, serializeVideoProject } from '@/videoproject/project';
import { humanizeError } from '@/videoproject/errors';

const log = createLogger('project-io');

export interface ProjectIO {
  newProject: () => void;
  open: () => Promise<void>;
  save: (asNew?: boolean) => Promise<void>;
  loadFromFile: (file: File) => Promise<void>;
}

/**
 * Project open/save. Desktop goes through the preload bridge and native
 * dialogs; the browser build falls back to a file input and a download, so the
 * same code path works in both.
 */
export function useProjectIO(): ProjectIO {
  const newProjectAction = useStore((state) => state.newProject);
  const loadProjectFromContent = useStore((state) => state.loadProjectFromContent);
  const markSaved = useStore((state) => state.markSaved);
  const notify = useStore((state) => state.notify);

  const newProject = useCallback(() => {
    // Each workspace owns its own document; New applies to the visible one.
    if (useStore.getState().workspace === 'captions') {
      if (!window.confirm('Fermer la vidéo et repartir de zéro ?')) return;
      useVideoStore.getState().clearVideo();
      notify('info', 'Projet vidéo réinitialisé');
      return;
    }
    const { dirty } = useStore.getState();
    if (dirty && !window.confirm('Le projet actuel n’est pas sauvegardé. Continuer ?')) return;
    newProjectAction();
    notify('info', 'Nouveau projet');
  }, [newProjectAction, notify]);

  const loadFromFile = useCallback(
    async (file: File) => {
      const content = await file.text();
      // The two project formats live side by side; pick by what the file holds.
      if (file.name.includes('.video-project') || content.includes('"videoPath"')) {
        try {
          useVideoStore.getState().hydrate(deserializeVideoProject(content));
          useStore.getState().setWorkspace('captions');
          notify('success', `Projet vidéo « ${file.name} » ouvert`);
        } catch (error) {
          notify('error', humanizeError(error));
        }
        return;
      }
      try {
        loadProjectFromContent(content, null);
        notify('success', `Projet « ${file.name} » ouvert`);
      } catch (error) {
        notify('error', humanizeError(error));
      }
    },
    [loadProjectFromContent, notify],
  );

  const open = useCallback(async () => {
    const { dirty } = useStore.getState();
    if (dirty && !window.confirm('Le projet actuel n’est pas sauvegardé. Continuer ?')) return;

    try {
      if (window.desktop) {
        const result = await window.desktop.openProject();
        if (!result) return;
        loadProjectFromContent(result.content, result.filePath);
        notify('success', 'Projet ouvert');
        return;
      }

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void loadFromFile(file);
      };
      input.click();
    } catch (error) {
      log.error('Ouverture impossible', error);
      notify('error', `Ouverture impossible : ${(error as Error).message}`);
    }
  }, [loadFromFile, loadProjectFromContent, notify]);

  const save = useCallback(
    async (asNew = false) => {
      const state = useStore.getState();

      if (state.workspace === 'captions') {
        await saveCaptionsProject(notify);
        return;
      }

      const content = serializeProject(state.project);
      const fileName = `${sanitizeFileName(state.project.name)}.project.json`;

      try {
        if (window.desktop) {
          const result = await window.desktop.saveProject({
            filePath: asNew ? null : state.filePath,
            content,
            suggestedName: state.filePath ?? fileName,
          });
          if (!result) return;
          markSaved(result.filePath);
          notify('success', 'Projet sauvegardé');
          return;
        }

        downloadBlob(new Blob([content], { type: 'application/json' }), fileName);
        markSaved(null);
        notify('success', 'Projet téléchargé');
      } catch (error) {
        log.error('Sauvegarde impossible', error);
        notify('error', `Sauvegarde impossible : ${(error as Error).message}`);
      }
    },
    [markSaved, notify],
  );

  return { newProject, open, save, loadFromFile };
}

/**
 * Writes the captions workspace to a `.video-project.json`.
 *
 * It records only the path of the source video plus the transcript, styles and
 * settings — the footage itself is never copied, so the file stays small and
 * the original is untouched.
 */
async function saveCaptionsProject(
  notify: (kind: 'info' | 'success' | 'error', message: string) => void,
): Promise<void> {
  const video = useVideoStore.getState();
  if (!video.metadata) {
    notify('error', 'Importez une vidéo avant de sauvegarder.');
    return;
  }

  const content = serializeVideoProject({
    version: 1,
    videoPath: video.metadata.path,
    metadata: video.metadata,
    transcript: video.transcript,
    track: video.track,
    segmentation: video.segmentation,
    style: video.style,
    animation: video.animation,
    presetId: video.presetId,
    language: video.language,
    tier: video.tier,
    output: video.output,
  });

  const base = sanitizeFileName(video.metadata.fileName.replace(/\.[^.]+$/, ''));
  const fileName = `${base}.video-project.json`;

  try {
    if (window.desktop) {
      const result = await window.desktop.saveProject({
        filePath: null,
        content,
        suggestedName: fileName,
      });
      if (!result) return;
      notify('success', 'Projet vidéo sauvegardé');
      return;
    }
    downloadBlob(new Blob([content], { type: 'application/json' }), fileName);
    notify('success', 'Projet vidéo téléchargé');
  } catch (error) {
    log.error('Sauvegarde vidéo impossible', error);
    notify('error', `Sauvegarde impossible : ${humanizeError(error)}`);
  }
}
