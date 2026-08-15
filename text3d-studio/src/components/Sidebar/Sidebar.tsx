import { useStore, type ToolSection } from '@/state/store';

const ITEMS: Array<{ id: ToolSection; icon: string; label: string; hint: string }> = [
  { id: 'text', icon: 'T', label: 'Texte', hint: 'Contenu, police, espacement, transformation' },
  { id: 'style', icon: '◐', label: 'Style', hint: 'Remplissage, contour, brillance' },
  { id: '3d', icon: '◱', label: '3D', hint: 'Extrusion et perspective' },
  { id: 'shadow', icon: '◍', label: 'Ombre', hint: 'Ombre portée et glow' },
  { id: 'animation', icon: '▶', label: 'Animation', hint: 'Timeline, presets, animation par lettre' },
  { id: 'effects', icon: '✦', label: 'Effets', hint: 'Sweep, jitter, wave, aberration…' },
  { id: 'presets', icon: '❖', label: 'Presets', hint: 'Bibliothèque de styles et randomize' },
];

export function Sidebar() {
  const tool = useStore((state) => state.tool);
  const setTool = useStore((state) => state.setTool);

  return (
    <nav className="sidebar">
      <div className="sidebar-section">Outils</div>
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`sidebar-item${tool === item.id ? ' active' : ''}`}
          onClick={() => setTool(item.id)}
          title={item.hint}
        >
          <span className="sidebar-icon">{item.icon}</span>
          <span className="sidebar-label">{item.label}</span>
        </button>
      ))}

      <div style={{ flex: 1 }} />
      <ShortcutHelp />
    </nav>
  );
}

function ShortcutHelp() {
  const shortcuts: Array<[string, string]> = [
    ['Espace', 'Lecture / Pause'],
    ['← →', 'Image ± 1'],
    ['Ctrl + Z / Y', 'Annuler / Rétablir'],
    ['Ctrl + S', 'Sauvegarder'],
    ['Ctrl + E', 'Exporter'],
    ['Maj + glisser', 'Déplacer le canvas'],
    ['Ctrl + molette', 'Zoom'],
  ];

  return (
    <div className="sidebar-label" style={{ padding: '10px', borderTop: '1px solid var(--border)' }}>
      <div className="sidebar-section" style={{ padding: '0 0 6px' }}>
        Raccourcis
      </div>
      {shortcuts.map(([keys, label]) => (
        <div key={keys} className="hint" style={{ display: 'flex', gap: 6, marginBottom: 3 }}>
          <span style={{ color: 'var(--text-1)', minWidth: 76 }}>{keys}</span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
