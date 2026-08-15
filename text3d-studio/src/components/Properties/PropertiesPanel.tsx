import { useStore } from '@/state/store';
import { TextPanel } from './TextPanel';
import { StylePanel } from './StylePanel';
import { ThreeDPanel } from './ThreeDPanel';
import { ShadowPanel } from './ShadowPanel';
import { AnimationPanel } from './AnimationPanel';
import { EffectsPanel } from './EffectsPanel';
import { PresetsPanel } from '../Presets/PresetsPanel';
import { LayersSection } from './LayersSection';
import type { ToolSection } from '@/state/store';

const TITLES: Record<ToolSection, string> = {
  text: 'Texte & transformation',
  style: 'Style de surface',
  '3d': 'Extrusion 3D',
  shadow: 'Ombre & glow',
  animation: 'Animation',
  effects: 'Effets dynamiques',
  presets: 'Presets',
};

export function PropertiesPanel() {
  const tool = useStore((state) => state.tool);

  return (
    <aside className="properties">
      <div className="panel-title">{TITLES[tool]}</div>
      <LayersSection />
      {tool === 'text' && <TextPanel />}
      {tool === 'style' && <StylePanel />}
      {tool === '3d' && <ThreeDPanel />}
      {tool === 'shadow' && <ShadowPanel />}
      {tool === 'animation' && <AnimationPanel />}
      {tool === 'effects' && <EffectsPanel />}
      {tool === 'presets' && <PresetsPanel />}
    </aside>
  );
}
