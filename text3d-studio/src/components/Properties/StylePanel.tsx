import { Section } from '../ui/Section';
import { SelectField, SliderField, ToggleField } from '../ui/Controls';
import { ColorField } from '../ColorPicker/ColorField';
import { useLayerValue } from '@/state/hooks';
import type { FillKind } from '@/types';

export function StylePanel() {
  const fillKind = useLayerValue<FillKind>('style.fill.kind');
  const strokeEnabled = useLayerValue<boolean>('style.stroke.enabled');
  const strokeGradient = useLayerValue<boolean>('style.stroke.gradient');
  const glossEnabled = useLayerValue<boolean>('style.gloss.enabled');

  const hasSecondColor = fillKind !== 'solid';
  const hasGradientAngle = fillKind === 'linear' || fillKind === 'glossy' || fillKind === 'metallic';

  return (
    <>
      <Section title="Face du texte">
        <SelectField
          path="style.fill.kind"
          label="Type de remplissage"
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'linear', label: 'Linear Gradient' },
            { value: 'radial', label: 'Radial Gradient' },
            { value: 'glossy', label: 'Glossy' },
            { value: 'metallic', label: 'Metallic' },
          ]}
        />
        <ColorField path="style.fill.color" label="Couleur principale" />
        {hasSecondColor && <ColorField path="style.fill.color2" label="Couleur secondaire" />}
        {fillKind === 'metallic' && <ColorField path="style.fill.color3" label="Couleur de reflet" />}
        {hasGradientAngle && (
          <SliderField
            path="style.fill.angle"
            label="Direction du dégradé"
            min={0}
            max={360}
            step={1}
            unit="°"
            decimals={0}
          />
        )}
        {(fillKind === 'glossy' || fillKind === 'metallic') && (
          <SliderField path="style.fill.midpoint" label="Point de rupture" min={0.05} max={0.95} step={0.01} />
        )}
        <SliderField path="style.fill.opacity" label="Opacité" min={0} max={1} step={0.01} />
        <SliderField path="style.fill.brightness" label="Luminosité" min={0} max={2.5} step={0.01} />
        <SliderField path="style.fill.contrast" label="Contraste" min={0} max={2.5} step={0.01} />
        <SliderField path="style.fill.saturation" label="Saturation" min={0} max={2.5} step={0.01} />
      </Section>

      <Section title="Contour">
        <ToggleField path="style.stroke.enabled" label="Activer" />
        {strokeEnabled && (
          <>
            <SliderField
              path="style.stroke.width"
              label="Épaisseur"
              min={0}
              max={80}
              step={0.5}
              unit=" px"
              decimals={1}
            />
            <ColorField path="style.stroke.color" label="Couleur" />
            <ToggleField path="style.stroke.gradient" label="Dégradé" />
            {strokeGradient && (
              <>
                <ColorField path="style.stroke.color2" label="Couleur 2" />
                <SliderField
                  path="style.stroke.angle"
                  label="Angle"
                  min={0}
                  max={360}
                  step={1}
                  unit="°"
                  decimals={0}
                />
              </>
            )}
            <SliderField path="style.stroke.opacity" label="Opacité" min={0} max={1} step={0.01} />
            <SelectField
              path="style.stroke.join"
              label="Jonction"
              options={[
                { value: 'round', label: 'Arrondie' },
                { value: 'miter', label: 'Pointue' },
                { value: 'bevel', label: 'Biseautée' },
              ]}
            />
            <SelectField
              path="style.stroke.align"
              label="Alignement"
              options={[
                { value: 'outside', label: 'Extérieur' },
                { value: 'center', label: 'Centré' },
              ]}
            />
          </>
        )}
      </Section>

      <Section title="Brillance / Gloss">
        <ToggleField path="style.gloss.enabled" label="Activer" />
        {glossEnabled && (
          <>
            <SliderField path="style.gloss.intensity" label="Intensité" min={0} max={2} step={0.01} />
            <SliderField path="style.gloss.position" label="Position" min={-0.5} max={1.5} step={0.01} />
            <SliderField path="style.gloss.width" label="Largeur" min={0.02} max={1} step={0.01} />
            <SliderField path="style.gloss.opacity" label="Opacité" min={0} max={1} step={0.01} />
            <SliderField
              path="style.gloss.angle"
              label="Angle"
              min={0}
              max={360}
              step={1}
              unit="°"
              decimals={0}
            />
            <ColorField path="style.gloss.color" label="Couleur" />
          </>
        )}
      </Section>
    </>
  );
}
