import { useEffect } from 'react';
import { useStore } from '@/state/store';
import { readJson, STORAGE_KEYS, writeJson } from '@/project/storage';
import { serializeProject } from '@/project/serialize';
import { createLogger } from '@/utils/logger';

const log = createLogger('autosave');
const INTERVAL_MS = 20_000;

export function isAutosaveEnabled(): boolean {
  return readJson<boolean>(STORAGE_KEYS.autosaveEnabled, true);
}

export function setAutosaveEnabled(enabled: boolean): void {
  writeJson(STORAGE_KEYS.autosaveEnabled, enabled);
  if (!enabled) writeJson(STORAGE_KEYS.autosave, null);
}

export function readAutosave(): string | null {
  return readJson<string | null>(STORAGE_KEYS.autosave, null);
}

export function clearAutosave(): void {
  writeJson(STORAGE_KEYS.autosave, null);
}

/**
 * Periodically mirrors the project into localStorage so a crash or an
 * accidental close does not lose the session. It never touches the user's file:
 * recovery is offered explicitly at startup.
 */
export function useAutosave(): void {
  useEffect(() => {
    const timer = setInterval(() => {
      const state = useStore.getState();
      if (!state.dirty || !isAutosaveEnabled()) return;
      const ok = writeJson(STORAGE_KEYS.autosave, serializeProject(state.project));
      if (ok) log.debug('Autosave écrit');
    }, INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      const state = useStore.getState();
      if (isAutosaveEnabled() && state.dirty) {
        writeJson(STORAGE_KEYS.autosave, serializeProject(state.project));
      }
      if (state.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
