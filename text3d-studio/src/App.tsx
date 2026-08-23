import { useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar/Toolbar';
import { Sidebar } from './components/Sidebar/Sidebar';
import { CanvasView } from './components/Canvas/CanvasView';
import { PropertiesPanel } from './components/Properties/PropertiesPanel';
import { Timeline } from './components/Timeline/Timeline';
import { VideoCaptionsWorkspace } from './components/VideoCaptions/VideoCaptionsWorkspace';
import { ExportDialog } from './components/Export/ExportDialog';
import { Notifications } from './components/ui/Notifications';
import { useProjectIO } from './hooks/useProjectIO';
import { useKeyboardShortcuts, useMenuCommands } from './hooks/useKeyboardShortcuts';
import { useAutosave, clearAutosave, readAutosave } from './hooks/useAutosave';
import { useDragAndDrop } from './hooks/useDragAndDrop';
import { useStore } from './state/store';
import { createLogger } from './utils/logger';

const log = createLogger('app');

export function App() {
  const io = useProjectIO();
  const dragging = useDragAndDrop(io);
  const workspace = useStore((state) => state.workspace);

  useKeyboardShortcuts(io);
  useMenuCommands(io);
  useAutosave();
  useAutosaveRecovery();

  return (
    <div className="app">
      <Toolbar io={io} />
      {workspace === 'text3d' ? (
        <>
          <div className="app-body">
            <Sidebar />
            <CanvasView />
            <PropertiesPanel />
          </div>
          <Timeline />
        </>
      ) : (
        <div className="app-body app-body-captions">
          <Sidebar />
          <VideoCaptionsWorkspace />
        </div>
      )}
      <ExportDialog />
      <Notifications />
      {dragging && (
        <div className="drop-overlay">
          Déposez un projet, un preset, une police ou une image de référence
        </div>
      )}
    </div>
  );
}

/** Offers to restore the last autosaved session once, at startup. */
function useAutosaveRecovery(): void {
  const [checked, setChecked] = useState(false);
  const loadProjectFromContent = useStore((state) => state.loadProjectFromContent);
  const notify = useStore((state) => state.notify);

  useEffect(() => {
    if (checked) return;
    setChecked(true);

    const saved = readAutosave();
    if (!saved) return;

    if (!window.confirm('Une session non sauvegardée a été retrouvée. La restaurer ?')) {
      clearAutosave();
      return;
    }

    try {
      loadProjectFromContent(saved, null);
      clearAutosave();
      notify('success', 'Session restaurée');
    } catch (error) {
      log.error('Restauration impossible', error);
      notify('error', 'La session sauvegardée est illisible.');
      clearAutosave();
    }
  }, [checked, loadProjectFromContent, notify]);
}
