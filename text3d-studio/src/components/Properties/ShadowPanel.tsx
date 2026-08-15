import { Section } from '../ui/Section';
import { SliderField, ToggleField } from '../ui/Controls';
import { ColorField } from '../ColorPicker/ColorField';
import { useLayerValue } from '@/state/hooks';

export function ShadowPanel() {
  const shadow = useLayerValue<boolean>('style.shadow.enabled');
  const glow = useLayerValue<boolean>('style.glow.enabled');

  return (
    <>
      <Section title="Ombre portée">
        <ToggleField path="style.shadow.enabled" label="Activer" />
        {shadow && (
          <>
            <SliderField path="style.shadow.x" label="Décalage X" min={-200} max={200} step={1} unit=" px" decimals={0} />
            <SliderField path="style.shadow.y" label="Décalage Y" min={-200} max={200} step={1} unit=" px" decimals={0} />
            <SliderField path="style.shadow.blur" label="Flou" min={0} max={200} step={1} unit=" px" decimals={0} />
            <SliderField
              path="style.shadow.spread"
              label="Étalement"
              min={-30}
              max={80}
              step={1}
              unit=" px"
              decimals={0}
            />
            <SliderField path="style.shadow.opacity" label="Opacité" min={0} max={1} step={0.01} />
            <ColorField path="style.shadow.color" label="Couleur" />
            <p className="hint">
              L’ombre est calculée à partir de la silhouette complète (extrusion et contour
              compris) et reste indépendante de l’extrusion.
            </p>
          </>
        )}
      </Section>

      <Section title="Glow">
        <ToggleField path="style.glow.enabled" label="Activer" />
        {glow && (
          <>
            <ColorField path="style.glow.color" label="Couleur" />
            <SliderField path="style.glow.intensity" label="Intensité" min={0} max={4} step={0.05} />
            <SliderField path="style.glow.blur" label="Flou" min={0} max={200} step={1} unit=" px" decimals={0} />
            <SliderField path="style.glow.opacity" label="Opacité" min={0} max={1} step={0.01} />
          </>
        )}
      </Section>
    </>
  );
}
