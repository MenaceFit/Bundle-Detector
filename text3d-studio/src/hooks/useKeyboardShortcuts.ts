import { useEffect } from 'react';
import { useStore } from '@/state/store';
import type { ProjectIO } from './useProjectIO';

/** True when the user is typing, so shortcuts must not steal the keystroke. */
function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useKeyboardShortcuts(io: ProjectIO): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const store = useStore.getState();
      const mod = event.ctrlKey || event.metaKey;
      const editing = isEditing(event.target);

      if (mod) {
        switch (event.key.toLowerCase()) {
          case 'n':
            event.preventDefault();
            io.newProject();
            return;
          case 'o':
            event.preventDefault();
            void io.open();
            return;
          case 's':
            event.preventDefault();
            void io.save(event.shiftKey);
            return;
          case 'e':
            event.preventDefault();
            store.setExportOpen(true);
            return;
          case 'z':
            if (editing) return;
            event.preventDefault();
            if (event.shiftKey) store.redo();
            else store.undo();
            return;
          case 'y':
            if (editing) return;
            event.preventDefault();
            store.redo();
            return;
          case 'd':
            if (editing) return;
            event.preventDefault();
            store.duplicateLayer();
            return;
          default:
            return;
        }
      }

      if (editing) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          store.togglePlay();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          store.stepFrame(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          store.stepFrame(1);
          break;
        case 'Home':
          event.preventDefault();
          store.setTime(0);
          break;
        case 'End':
          event.preventDefault();
          store.setTime(store.project.timeline.duration);
          break;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          store.removeLayer();
          break;
        case '0':
          store.resetView();
          break;
        case '+':
        case '=':
          store.zoomBy(1.2);
          break;
        case '-':
          store.zoomBy(1 / 1.2);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [io]);
}

/** Wires the native Electron menu to the same actions as the shortcuts. */
export function useMenuCommands(io: ProjectIO): void {
  useEffect(() => {
    if (!window.desktop) return;
    return window.desktop.onMenuCommand((command) => {
      const store = useStore.getState();
      switch (command) {
        case 'new':
          io.newProject();
          break;
        case 'open':
          void io.open();
          break;
        case 'save':
          void io.save(false);
          break;
        case 'saveAs':
          void io.save(true);
          break;
        case 'export':
          store.setExportOpen(true);
          break;
        case 'undo':
          store.undo();
          break;
        case 'redo':
          store.redo();
          break;
        default:
          break;
      }
    });
  }, [io]);
}
