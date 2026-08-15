import { Section } from '../ui/Section';
import { Field } from '../ui/Field';
import { SliderField, ToggleField } from '../ui/Controls';
import { ColorField } from '../ColorPicker/ColorField';
import { useLayerValue } from '@/state/hooks';
import { useStore } from '@/state/store';

export function ThreeDPanel() {
  const enabled = useLayerValue<boolean>('style.extrusion.enabled');
  const gradient = useLayerValue<boolean>('style.extrusion.gradient');
  const dirX = useLayerValue<number>('style.extrusion.dirX');
  const dirY = useLayerValue<number>('style.extrusion.dirY');
  const steps = useLayerValue<number>('style.extrusion.steps') ?? 0;
  const patchLayer = useStore((state) => state.patchLayer);

  const setDirection = (x: number, y: number): void => {
    patchLayer('style.extrusion.dirX', x);
    patchLayer('style.extrusion.dirY', y);
  };

  return (
    <>
      <Section title="Extrusion 3D">
        <ToggleField path="style.extrusion.enabled" label="Activer" />
        {enabled && (
          <>
            <SliderField
              path="style.extrusion.depth"
              label="Profondeur"
              min={0}
              max={200}
              step={0.5}
              unit=" px"
              decimals={1}
            />
            <SliderField
              path="style.extrusion.steps"
              label="Nombre de couches"
              min={1}
              max={80}
              step={1}
              decimals={0}
              />
            <SliderField path="style.extrusion.dirX" label="Direction X" min={-10} max={10} step={0.1} />
            <SliderField path="style.extrusion.dirY" label="Direction Y" min={-10} max={10} step={0.1} />

            <Field label="Direction rapide">
              <DirectionPad current={{ x: dirX, y: dirY }} onPick={setDirection} />
            </Field>

            <ColorField path="style.extrusion.color" label="Couleur proche" />
            <ToggleField path="style.extrusion.gradient" label="Dégradé de profondeur" />
            {gradient && <ColorField path="style.extrusion.color2" label="Couleur lointaine" />}
            <SliderField path="style.extrusion.opacity" label="Opacité" min={0} max={1} step={0.01} />
            <SliderField
              path="style.extrusion.blur"
              label="Flou"
              min={0}
              max={30}
              step={0.5}
              unit=" px"
              decimals={1}
            />
            <p className="hint">
              L’extrusion est reconstruite à chaque image : {Math.round(steps)} copies décalées
              entre la face et le point de fuite.
            </p>
          </>
        )}
      </Section>

      <Section title="Perspective">
        <SliderField
          path="transform.perspective"
          label="Déformation trapézoïdale"
          min={-1}
          max={1}
          step={0.01}
        />
        <p className="hint">
          Valeur positive : la base s’élargit (caméra en plongée). Valeur négative : le haut
          s’élargit.
        </p>
      </Section>
    </>
  );
}

function DirectionPad({
  current,
  onPick,
}: {
  current: { x: number; y: number };
  onPick: (x: number, y: number) => void;
}) {
  const directions: Array<[string, number, number]> = [
    ['↖', -4, -4],
    ['↑', 0, -6],
    ['↗', 4, -4],
    ['←', -6, 0],
    ['•', 0, 0],
    ['→', 6, 0],
    ['↙', -4, 4],
    ['↓', 0, 6],
    ['↘', 3, 5],
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
      {directions.map(([icon, x, y]) => {
        const active = Math.abs(current.x - x) < 0.6 && Math.abs(current.y - y) < 0.6;
        return (
          <button
            key={icon + String(x) + String(y)}
            type="button"
            className={`btn btn-sm${active ? ' active' : ''}`}
            style={{ justifyContent: 'center' }}
            onClick={() => onPick(x, y)}
          >
            {icon}
          </button>
        );
      })}
    </div>
  );
}
