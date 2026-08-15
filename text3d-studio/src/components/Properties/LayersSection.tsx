import { Section } from '../ui/Section';
import { useStore } from '@/state/store';

/**
 * Layer list. V1 compositions are usually a single text layer, but the document
 * model, the renderer and the exporters already iterate over a list, so extra
 * layers (and later, other layer kinds) drop straight in.
 */
export function LayersSection() {
  const layers = useStore((state) => state.project.layers);
  const activeId = useStore((state) => state.project.activeLayerId);
  const selectLayer = useStore((state) => state.selectLayer);
  const addLayer = useStore((state) => state.addLayer);
  const duplicateLayer = useStore((state) => state.duplicateLayer);
  const removeLayer = useStore((state) => state.removeLayer);
  const moveLayer = useStore((state) => state.moveLayer);
  const updateLayerMeta = useStore((state) => state.updateLayerMeta);

  return (
    <Section title={`Calques (${layers.length})`} defaultOpen={layers.length > 1}>
      {[...layers].reverse().map((layer) => (
        <div key={layer.id} className={`layer-row${layer.id === activeId ? ' active' : ''}`}>
          <button
            type="button"
            title={layer.visible ? 'Masquer' : 'Afficher'}
            onClick={() => updateLayerMeta(layer.id, { visible: !layer.visible })}
          >
            {layer.visible ? '👁' : '◌'}
          </button>
          <button
            type="button"
            className="layer-name"
            onClick={() => selectLayer(layer.id)}
            onDoubleClick={() => {
              const name = window.prompt('Nom du calque', layer.name);
              if (name) updateLayerMeta(layer.id, { name: name.trim() });
            }}
            title="Cliquer pour sélectionner · double-clic pour renommer"
          >
            {layer.name}
          </button>
          <button
            type="button"
            title={layer.locked ? 'Déverrouiller' : 'Verrouiller'}
            onClick={() => updateLayerMeta(layer.id, { locked: !layer.locked })}
          >
            {layer.locked ? '🔒' : '🔓'}
          </button>
          <button type="button" title="Monter" onClick={() => moveLayer(layer.id, 1)}>
            ↑
          </button>
          <button type="button" title="Descendre" onClick={() => moveLayer(layer.id, -1)}>
            ↓
          </button>
        </div>
      ))}

      <div className="field-row">
        <button type="button" className="btn btn-sm" onClick={addLayer}>
          + Calque
        </button>
        <button type="button" className="btn btn-sm" onClick={() => duplicateLayer()}>
          Dupliquer
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => removeLayer()}
          disabled={layers.length <= 1}
        >
          Supprimer
        </button>
      </div>
    </Section>
  );
}
