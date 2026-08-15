import { Section } from '../ui/Section';
import { Field } from '../ui/Field';
import {
  SegmentedField,
  SliderField,
  SliderControl,
  ToggleField,
  NumberControl,
} from '../ui/Controls';
import { FontSelector } from './FontSelector';
import { useActiveLayer, useLayerValue } from '@/state/hooks';
import { useStore } from '@/state/store';

export function TextPanel() {
  const layer = useActiveLayer();
  const setText = useStore((state) => state.setText);
  const patchLayer = useStore((state) => state.patchLayer);
  const resetTransform = useStore((state) => state.resetTransform);
  const maxWidth = useLayerValue<number | null>('typography.maxWidth');

  return (
    <>
      <Section title="Texte">
        <Field label="Contenu" hint="Utilisez Entrée pour créer une nouvelle ligne">
          <textarea
            className="input"
            value={layer.text}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            placeholder="TEXTE"
          />
        </Field>

        <ToggleField path="typography.uppercase" label="Majuscules" />

        <SegmentedField
          path="typography.align"
          label="Alignement horizontal"
          options={[
            { value: 'left', label: '⯇', title: 'Gauche' },
            { value: 'center', label: '⯀', title: 'Centre' },
            { value: 'right', label: '⯈', title: 'Droite' },
          ]}
        />

        <Field label="Alignement vertical" hint="Point d’ancrage vertical du bloc de texte">
          <div className="segmented">
            {(
              [
                ['Haut', 0],
                ['Milieu', 0.5],
                ['Bas', 1],
              ] as const
            ).map(([label, value]) => (
              <button
                key={label}
                type="button"
                className={layer.transform.anchorY === value ? 'active' : ''}
                onClick={() => patchLayer('transform.anchorY', value)}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="Largeur maximale"
          hint="Retour à la ligne automatique ; désactivé quand vide"
          value={maxWidth === null ? 'auto' : `${Math.round(maxWidth)}px`}
        >
          <div className="field-row">
            <input
              className="slider"
              type="range"
              min={100}
              max={4000}
              step={10}
              value={maxWidth ?? 4000}
              onChange={(event) => patchLayer('typography.maxWidth', Number(event.target.value), {
                commitKey: 'typography.maxWidth',
              })}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => patchLayer('typography.maxWidth', maxWidth === null ? 1000 : null)}
            >
              {maxWidth === null ? 'Activer' : 'Auto'}
            </button>
          </div>
        </Field>
      </Section>

      <Section title="Police">
        <FontSelector />
        <SliderField path="typography.fontSize" label="Taille" min={8} max={900} step={1} unit=" px" decimals={0} />
        <Field label="Graisse" path="typography.fontWeight">
          <div className="segmented">
            {[300, 400, 600, 700, 800, 900].map((weight) => (
              <button
                key={weight}
                type="button"
                className={layer.typography.fontWeight === weight ? 'active' : ''}
                onClick={() => patchLayer('typography.fontWeight', weight)}
              >
                {weight}
              </button>
            ))}
          </div>
        </Field>
        <SegmentedField
          path="typography.fontStyle"
          label="Style"
          options={[
            { value: 'normal', label: 'Normal' },
            { value: 'italic', label: 'Italique' },
          ]}
        />
      </Section>

      <Section title="Espacement">
        <SliderField
          path="typography.letterSpacing"
          label="Letter spacing"
          min={-60}
          max={200}
          step={0.5}
          unit=" px"
          decimals={1}
        />
        <SliderField
          path="typography.wordSpacing"
          label="Word spacing"
          min={-60}
          max={200}
          step={0.5}
          unit=" px"
          decimals={1}
        />
        <SliderField
          path="typography.lineHeight"
          label="Interligne"
          min={0.4}
          max={3}
          step={0.01}
          decimals={2}
        />
        <SliderField
          path="typography.horizontalScale"
          label="Échelle horizontale"
          min={0.2}
          max={3}
          step={0.01}
          decimals={2}
        />
        <SliderField
          path="typography.verticalScale"
          label="Échelle verticale"
          min={0.2}
          max={3}
          step={0.01}
          decimals={2}
        />
      </Section>

      <Section
        title="Transformation"
        right={
          <span
            className="btn btn-sm"
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              resetTransform();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') resetTransform();
            }}
          >
            Reset
          </span>
        }
      >
        <SliderField path="transform.x" label="Position X" min={-2000} max={2000} step={1} unit=" px" decimals={0} />
        <SliderField path="transform.y" label="Position Y" min={-2000} max={2000} step={1} unit=" px" decimals={0} />
        <SliderField path="transform.scaleX" label="Scale X" min={0.05} max={4} step={0.01} decimals={2} />
        <SliderField path="transform.scaleY" label="Scale Y" min={0.05} max={4} step={0.01} decimals={2} />
        <SliderField path="transform.rotation" label="Rotation" min={-180} max={180} step={0.5} unit="°" decimals={1} />
        <SliderField path="transform.skewX" label="Skew X" min={-60} max={60} step={0.5} unit="°" decimals={1} />
        <SliderField path="transform.skewY" label="Skew Y" min={-60} max={60} step={0.5} unit="°" decimals={1} />
        <SliderField
          path="transform.perspective"
          label="Perspective"
          min={-1}
          max={1}
          step={0.01}
          decimals={2}
        />

        <Field label="Point d’ancrage" hint="Pivot des rotations et des mises à l’échelle">
          <div className="field-row">
            <span className="hint">X</span>
            <SliderControl
              value={layer.transform.anchorX}
              onChange={(value) => patchLayer('transform.anchorX', value, { commitKey: 'anchorX' })}
              min={0}
              max={1}
              step={0.01}
            />
          </div>
          <div className="field-row">
            <span className="hint">Y</span>
            <SliderControl
              value={layer.transform.anchorY}
              onChange={(value) => patchLayer('transform.anchorY', value, { commitKey: 'anchorY' })}
              min={0}
              max={1}
              step={0.01}
            />
          </div>
        </Field>

        <Field label="Opacité du calque" path="opacity" value={`${Math.round(layer.opacity * 100)} %`}>
          <SliderControl
            value={layer.opacity}
            onChange={(value) => patchLayer('opacity', value, { commitKey: 'opacity' })}
            min={0}
            max={1}
            step={0.01}
          />
        </Field>
      </Section>

      <Section title="Canvas" defaultOpen={false}>
        <CanvasSizeFields />
      </Section>
    </>
  );
}

function CanvasSizeFields() {
  const width = useStore((state) => state.project.canvas.width);
  const height = useStore((state) => state.project.canvas.height);
  const setCanvasSize = useStore((state) => state.setCanvasSize);

  const presets: Array<[string, number, number]> = [
    ['1200 × 800', 1200, 800],
    ['1080 × 1080', 1080, 1080],
    ['1920 × 1080', 1920, 1080],
    ['1080 × 1920', 1080, 1920],
  ];

  return (
    <>
      <Field label="Dimensions du plan de travail">
        <div className="field-row">
          <NumberControl
            value={width}
            onChange={(value) => setCanvasSize(value, height)}
            min={16}
            max={16384}
            decimals={0}
          />
          <span className="hint">×</span>
          <NumberControl
            value={height}
            onChange={(value) => setCanvasSize(width, value)}
            min={16}
            max={16384}
            decimals={0}
          />
        </div>
      </Field>
      <div className="anim-list">
        {presets.map(([label, w, h]) => (
          <button
            key={label}
            type="button"
            className="anim-btn"
            onClick={() => setCanvasSize(w, h)}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
