import { useEffect } from 'react';
import { useStore } from '@/state/store';
import { useVideoStore } from '@/videoproject/store';

/** True while the user is typing, so a shortcut never eats a keystroke. */
function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Transport shortcuts for the captions workspace.
 *
 * Registered only while that workspace is active, so it cannot collide with the
 * 3D timeline's own bindings.
 */
export function useCaptionShortcuts(): void {
  const workspace = useStore((state) => state.workspace);

  useEffect(() => {
    if (workspace !== 'captions') return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditing(event.target) || event.ctrlKey || event.metaKey) return;
      const store = useVideoStore.getState();
      if (!store.metadata) return;

      const frame = 1 / Math.max(1, store.output.fps);

      switch (event.key) {
        case ' ':
          event.preventDefault();
          store.setPlaying(!store.playing);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          store.setPlaying(false);
          store.setTime(store.time - (event.shiftKey ? frame * 10 : frame));
          break;
        case 'ArrowRight':
          event.preventDefault();
          store.setPlaying(false);
          store.setTime(store.time + (event.shiftKey ? frame * 10 : frame));
          break;
        case 'Home':
          event.preventDefault();
          store.setTime(0);
          break;
        case 'End':
          event.preventDefault();
          store.setTime(store.metadata.durationSec);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [workspace]);
}
