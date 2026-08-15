import { useCallback } from 'react';
import { useStore } from '@/state/store';
import { serializeProject } from '@/project/serialize';
import { downloadBlob } from '@/export/save';
import { sanitizeFileName } from '@/utils/format';
import { createLogger } from '@/utils/logger';

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
    const { dirty } = useStore.getState();
    if (dirty && !window.confirm('Le projet actuel n’est pas sauvegardé. Continuer ?')) return;
    newProjectAction();
    notify('info', 'Nouveau projet');
  }, [newProjectAction, notify]);

  const loadFromFile = useCallback(
    async (file: File) => {
      try {
        loadProjectFromContent(await file.text(), null);
        notify('success', `Projet « ${file.name} » ouvert`);
      } catch (error) {
        notify('error', (error as Error).message);
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
