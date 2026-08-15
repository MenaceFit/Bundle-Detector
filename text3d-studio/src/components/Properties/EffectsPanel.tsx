import { Section } from '../ui/Section';
import { SliderField, ToggleField } from '../ui/Controls';
import { ColorField } from '../ColorPicker/ColorField';
import { useLayerValue } from '@/state/hooks';

export function EffectsPanel() {
  const sweep = useLayerValue<boolean>('effects.sweep.enabled');
  const colorCycle = useLayerValue<boolean>('effects.colorCycle.enabled');
  const jitter = useLayerValue<boolean>('effects.jitter.enabled');
  const wave = useLayerValue<boolean>('effects.wave.enabled');
  const chromatic = useLayerValue<boolean>('effects.chromatic.enabled');
  const noise = useLayerValue<boolean>('effects.noise.enabled');

  return (
    <>
      <Section title="Light sweep / Shimmer">
        <ToggleField path="effects.sweep.enabled" label="Activer" />
        {sweep && (
          <>
            <SliderField path="effects.sweep.speed" label="Vitesse" min={0} max={4} step={0.05} />
            <SliderField path="effects.sweep.width" label="Largeur" min={0.02} max={1} step={0.01} />
            <SliderField path="effects.sweep.intensity" label="Intensité" min={0} max={1} step={0.01} />
            <SliderField path="effects.sweep.angle" label="Angle" min={0} max={360} step={1} unit="°" decimals={0} />
            <ColorField path="effects.sweep.color" label="Couleur" />
          </>
        )}
      </Section>

      <Section title="Color cycling" defaultOpen={false}>
        <ToggleField path="effects.colorCycle.enabled" label="Activer" />
        {colorCycle && (
          <>
            <SliderField path="effects.colorCycle.speed" label="Vitesse" min={0} max={3} step={0.01} />
            <SliderField
              path="effects.colorCycle.range"
              label="Amplitude de teinte"
              min={0}
              max={360}
              step={1}
              unit="°"
              decimals={0}
            />
          </>
        )}
      </Section>

      <Section title="Jitter / Shake" defaultOpen={false}>
        <ToggleField path="effects.jitter.enabled" label="Activer" />
        {jitter && (
          <>
            <SliderField path="effects.jitter.amount" label="Amplitude" min={0} max={40} step={0.5} unit=" px" decimals={1} />
            <SliderField path="effects.jitter.speed" label="Vitesse" min={0.1} max={40} step={0.1} />
            <SliderField path="effects.jitter.seed" label="Graine" min={1} max={9999} step={1} decimals={0} />
          </>
        )}
      </Section>

      <Section title="Wave distortion" defaultOpen={false}>
        <ToggleField path="effects.wave.enabled" label="Activer" />
        {wave && (
          <>
            <SliderField path="effects.wave.amplitude" label="Amplitude" min={0} max={200} step={1} unit=" px" decimals={0} />
            <SliderField path="effects.wave.frequency" label="Fréquence" min={0} max={4} step={0.01} />
            <SliderField path="effects.wave.speed" label="Vitesse" min={-4} max={4} step={0.01} />
            <p className="hint">L’onde décale chaque lettre indépendamment le long de l’axe vertical.</p>
          </>
        )}
      </Section>

      <Section title="Aberration chromatique" defaultOpen={false}>
        <ToggleField path="effects.chromatic.enabled" label="Activer" />
        {chromatic && (
          <>
            <SliderField path="effects.chromatic.amount" label="Écart" min={0} max={40} step={0.5} unit=" px" decimals={1} />
            <SliderField path="effects.chromatic.angle" label="Angle" min={0} max={360} step={1} unit="°" decimals={0} />
          </>
        )}
      </Section>

      <Section title="Grain" defaultOpen={false}>
        <ToggleField path="effects.noise.enabled" label="Activer" />
        {noise && <SliderField path="effects.noise.amount" label="Intensité" min={0} max={0.6} step={0.01} />}
      </Section>
    </>
  );
}
