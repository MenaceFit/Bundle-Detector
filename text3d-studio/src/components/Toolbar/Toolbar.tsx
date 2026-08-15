import { useStore } from '@/state/store';
import type { ProjectIO } from '@/hooks/useProjectIO';

export function Toolbar({ io }: { io: ProjectIO }) {
  const name = useStore((state) => state.project.name);
  const dirty = useStore((state) => state.dirty);
  const setProjectName = useStore((state) => state.setProjectName);
  const setExportOpen = useStore((state) => state.setExportOpen);
  const undo = useStore((state) => state.undo);
  const redo = useStore((state) => state.redo);
  const canUndo = useStore((state) => state.past.length > 0);
  const canRedo = useStore((state) => state.future.length > 0);

  return (
    <header className="toolbar">
      <div className="logo">
        <span className="logo-mark">3D</span>
        <span>TEXT3D STUDIO</span>
      </div>

      <button type="button" className="btn btn-ghost" onClick={io.newProject} title="Ctrl + N">
        Nouveau
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => void io.open()} title="Ctrl + O">
        Ouvrir
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => void io.save(false)} title="Ctrl + S">
        Sauvegarder
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => void io.save(true)}
        title="Ctrl + Maj + S"
      >
        Sauvegarder sous
      </button>

      <span style={{ width: 1, height: 20, background: 'var(--border)' }} />

      <button
        type="button"
        className="btn btn-icon btn-ghost"
        onClick={undo}
        disabled={!canUndo}
        title="Annuler (Ctrl + Z)"
      >
        ↶
      </button>
      <button
        type="button"
        className="btn btn-icon btn-ghost"
        onClick={redo}
        disabled={!canRedo}
        title="Rétablir (Ctrl + Y)"
      >
        ↷
      </button>

      <div className="toolbar-spacer" />

      {dirty && <span className="dirty-dot" title="Modifications non sauvegardées" />}
      <input
        className="project-name"
        value={name}
        onChange={(event) => setProjectName(event.target.value)}
        title="Nom du projet"
        spellCheck={false}
      />

      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setExportOpen(true)}
        title="Ctrl + E"
      >
        Exporter
      </button>
    </header>
  );
}
