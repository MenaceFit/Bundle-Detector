import { Section } from '../ui/Section';
import { Field } from '../ui/Field';
import { NumberControl, Segmented, SelectControl, SliderControl, Toggle } from '../ui/Controls';
import { ColorSwatch } from '../ColorPicker/ColorField';
import { useVideoStore } from '@/videoproject/store';
import { BUILTIN_CAPTION_PRESETS } from '@/captions/presets';
import type { ActiveMotionKind, RevealMode, WordAnimationKind } from '@/captions/types';

const WORD_ANIMATIONS: Array<{ value: WordAnimationKind; label: string }> = [
  { value: 'none', label: 'Aucune' },
  { value: 'pop', label: 'Pop' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'scale', label: 'Scale' },
  { value: 'fade', label: 'Fade' },
  { value: 'slideUp', label: 'Slide Up' },
  { value: 'slideDown', label: 'Slide Down' },
  { value: 'slideLeft', label: 'Slide Left' },
  { value: 'slideRight', label: 'Slide Right' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'flip', label: 'Flip' },
  { value: 'blur', label: 'Blur' },
  { value: 'elastic', label: 'Elastic' },
  { value: 'shake', label: 'Shake' },
  { value: 'punch', label: 'Punch' },
  { value: 'glow', label: 'Glow' },
  { value: 'spring', label: 'Spring' },
  { value: 'impact', label: 'Impact' },
  { value: 'whip', label: 'Whip' },
  { value: 'dropIn', label: 'Drop In' },
  { value: 'zoomBlur', label: 'Zoom Blur' },
  { value: 'swing', label: 'Swing' },
  { value: 'riseUp', label: 'Rise Up' },
  { value: 'flicker', label: 'Flicker' },
];

/** Motion kept on the word while it is being spoken. */
const ACTIVE_MOTIONS: Array<{ value: ActiveMotionKind; label: string }> = [
  { value: 'none', label: 'Aucune' },
  { value: 'pulse', label: 'Pulsation' },
  { value: 'breathe', label: 'Respiration' },
  { value: 'wobble', label: 'Balancement' },
  { value: 'float', label: 'Flottement' },
];

/** Style, animation and segmentation controls for the caption track. */
export function CaptionProperties() {
  const style = useVideoStore((state) => state.style);
  const animation = useVideoStore((state) => state.animation);
  const presetId = useVideoStore((state) => state.presetId);
  const segmentation = useVideoStore((state) => state.segmentation);
  const applyPreset = useVideoStore((state) => state.applyPreset);
  const patchStyle = useVideoStore((state) => state.patchStyle);
  const patchStylePath = useVideoStore((state) => state.patchStylePath);
  const patchAnimation = useVideoStore((state) => state.patchAnimation);
  const resegment = useVideoStore((state) => state.resegment);

  return (
    <>
      <Section title="Presets">
        <div className="anim-list">
          {BUILTIN_CAPTION_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`anim-btn${presetId === preset.id ? ' active' : ''}`}
              title={preset.description}
              onClick={() => applyPreset(preset.id)}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Découpage">
        <Field
          label="Mots par sous-titre"
          value={segmentation.wordsPerCue === null ? 'Auto' : String(segmentation.wordsPerCue)}
          hint="Auto choisit la longueur d’après le débit de parole"
        >
          <div className="segmented">
            {([null, 1, 2, 3, 4, 5, 6, 7, 8] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                className={segmentation.wordsPerCue === value ? 'active' : ''}
                onClick={() => resegment({ wordsPerCue: value })}
              >
                {value === null ? 'Auto' : value}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Durée maximale" value={`${segmentation.maxDurationSec.toFixed(1)} s`}>
          <SliderControl
            value={segmentation.maxDurationSec}
            onChange={(value) => resegment({ maxDurationSec: value })}
            min={0.6}
            max={8}
            step={0.1}
          />
        </Field>
        <Field label="Caractères maximum" value={String(segmentation.maxCharacters)}>
          <SliderControl
            value={segmentation.maxCharacters}
            onChange={(value) => resegment({ maxCharacters: Math.round(value) })}
            min={12}
            max={90}
            step={1}
            decimals={0}
          />
        </Field>
        <Field label="Silence qui coupe" value={`${segmentation.pauseBreakSec.toFixed(2)} s`}>
          <SliderControl
            value={segmentation.pauseBreakSec}
            onChange={(value) => resegment({ pauseBreakSec: value })}
            min={0.1}
            max={1.5}
            step={0.05}
          />
        </Field>
        <div className="field-head">
          <span className="field-label">Respecter la ponctuation</span>
          <Toggle
            value={segmentation.respectPunctuation}
            onChange={(value) => resegment({ respectPunctuation: value })}
          />
        </div>
      </Section>

      <Section title="Affichage">
        <Field label="Mode d’apparition">
          <SelectControl<RevealMode>
            value={style.reveal}
            onChange={(reveal) => patchStyle({ reveal })}
            options={[
              { value: 'karaoke', label: 'Karaoké — phrase entière, mot actif coloré' },
              { value: 'wordByWord', label: 'Mot par mot' },
              { value: 'all', label: 'Phrase entière' },
            ]}
          />
        </Field>
        {style.reveal === 'wordByWord' && (
          <Field label="Mots visibles" value={String(style.visibleWords)}>
            <SliderControl
              value={style.visibleWords}
              onChange={(visibleWords) => patchStyle({ visibleWords: Math.round(visibleWords) })}
              min={1}
              max={6}
              step={1}
              decimals={0}
            />
          </Field>
        )}
        <Field label="Position">
          <Segmented
            value={style.position}
            options={[
              { value: 'top', label: 'Haut' },
              { value: 'center', label: 'Centre' },
              { value: 'bottom', label: 'Bas' },
            ]}
            onChange={(position) => patchStyle({ position: position as typeof style.position })}
          />
        </Field>
        <Field label="Décalage vertical" value={`${Math.round(style.offsetYRatio * 100)} %`}>
          <SliderControl
            value={style.offsetYRatio}
            onChange={(offsetYRatio) => patchStyle({ offsetYRatio })}
            min={-0.45}
            max={0.45}
            step={0.005}
          />
        </Field>
        <Field label="Taille" value={`${Math.round(style.fontSizeRatio * 1000) / 10} % h`}>
          <SliderControl
            value={style.fontSizeRatio}
            onChange={(fontSizeRatio) => patchStyle({ fontSizeRatio })}
            min={0.02}
            max={0.16}
            step={0.002}
          />
        </Field>
        <Field label="Largeur maximale" value={`${Math.round(style.maxWidthRatio * 100)} %`}>
          <SliderControl
            value={style.maxWidthRatio}
            onChange={(maxWidthRatio) => patchStyle({ maxWidthRatio })}
            min={0.3}
            max={1}
            step={0.01}
          />
        </Field>
        <div className="field-head">
          <span className="field-label">Majuscules</span>
          <Toggle value={style.uppercase} onChange={(uppercase) => patchStyle({ uppercase })} />
        </div>
      </Section>

      <Section title="Couleurs">
        <div className="field-head">
          <span className="field-label">Texte</span>
          <ColorSwatch
            value={style.layer.fill.color}
            onChange={(color) => {
              patchStylePath('layer.fill.color', color);
              patchStylePath('layer.fill.color2', color);
            }}
          />
        </div>
        <div className="field-head">
          <span className="field-label">Contour</span>
          <ColorSwatch
            value={style.layer.stroke.color}
            onChange={(color) => patchStylePath('layer.stroke.color', color)}
          />
        </div>
        <Field label="Épaisseur du contour" value={`${style.layer.stroke.width} px`}>
          <SliderControl
            value={style.layer.stroke.width}
            onChange={(value) => patchStylePath('layer.stroke.width', value)}
            min={0}
            max={30}
            step={0.5}
          />
        </Field>
        <div className="field-head">
          <span className="field-label">Mot actif coloré</span>
          <Toggle
            value={style.activeWord.enabled}
            onChange={(value) => patchStylePath('activeWord.enabled', value)}
          />
        </div>
        {style.activeWord.enabled && (
          <>
            <div className="field-head">
              <span className="field-label">Couleur du mot actif</span>
              <ColorSwatch
                value={style.activeWord.color}
                onChange={(color) => patchStylePath('activeWord.color', color)}
              />
            </div>
            <Field label="Grossissement du mot actif" value={`× ${style.activeWord.scale.toFixed(2)}`}>
              <SliderControl
                value={style.activeWord.scale}
                onChange={(value) => patchStylePath('activeWord.scale', value)}
                min={1}
                max={1.6}
                step={0.01}
              />
            </Field>
            <div className="field-head">
              <span className="field-label">Fond derrière le mot actif</span>
              <Toggle
                value={style.activeWord.box}
                onChange={(value) => patchStylePath('activeWord.box', value)}
              />
            </div>
            {style.activeWord.box && (
              <>
                <div className="field-head">
                  <span className="field-label">Couleur du fond</span>
                  <ColorSwatch
                    value={style.activeWord.boxColor}
                    onChange={(color) => patchStylePath('activeWord.boxColor', color)}
                  />
                </div>
                <Field label="Arrondi" value={`${style.activeWord.boxRadius} px`}>
                  <SliderControl
                    value={style.activeWord.boxRadius}
                    onChange={(value) => patchStylePath('activeWord.boxRadius', value)}
                    min={0}
                    max={60}
                    step={1}
                    decimals={0}
                  />
                </Field>
              </>
            )}
          </>
        )}
        <div className="field-head">
          <span className="field-label">Mots importants</span>
          <ColorSwatch
            value={style.emphasisColor}
            onChange={(color) => patchStyle({ emphasisColor: color })}
          />
        </div>
        <Field label="Taille des mots importants" value={`× ${style.emphasisScale.toFixed(2)}`}>
          <SliderControl
            value={style.emphasisScale}
            onChange={(emphasisScale) => patchStyle({ emphasisScale })}
            min={0.8}
            max={1.8}
            step={0.01}
          />
        </Field>
        <div className="field-head">
          <span className="field-label">Mots importants en italique</span>
          <Toggle
            value={style.emphasisItalic}
            onChange={(emphasisItalic) => patchStyle({ emphasisItalic })}
          />
        </div>
      </Section>

      <Section title="Relief 3D" defaultOpen={false}>
        <p className="hint">
          Ces réglages sont ceux du moteur 3D de l’application : un sous-titre est un calque texte
          du même moteur.
        </p>
        <div className="field-head">
          <span className="field-label">Extrusion</span>
          <Toggle
            value={style.layer.extrusion.enabled}
            onChange={(value) => patchStylePath('layer.extrusion.enabled', value)}
          />
        </div>
        {style.layer.extrusion.enabled && (
          <Field label="Profondeur" value={`${style.layer.extrusion.depth} px`}>
            <SliderControl
              value={style.layer.extrusion.depth}
              onChange={(value) => patchStylePath('layer.extrusion.depth', value)}
              min={0}
              max={60}
              step={1}
              decimals={0}
            />
          </Field>
        )}
        <div className="field-head">
          <span className="field-label">Ombre portée</span>
          <Toggle
            value={style.layer.shadow.enabled}
            onChange={(value) => patchStylePath('layer.shadow.enabled', value)}
          />
        </div>
        <div className="field-head">
          <span className="field-label">Glow</span>
          <Toggle
            value={style.layer.glow.enabled}
            onChange={(value) => patchStylePath('layer.glow.enabled', value)}
          />
        </div>
      </Section>

      <Section title="Animation des mots">
        <Field label="Animation">
          <SelectControl<WordAnimationKind>
            value={animation.word}
            onChange={(word) => patchAnimation({ word })}
            options={WORD_ANIMATIONS}
          />
        </Field>
        <Field label="Durée" value={`${animation.wordDuration.toFixed(2)} s`}>
          <SliderControl
            value={animation.wordDuration}
            onChange={(wordDuration) => patchAnimation({ wordDuration })}
            min={0}
            max={1}
            step={0.01}
          />
        </Field>
        <Field
          label="Décalage entre mots"
          value={`${animation.wordStagger.toFixed(3)} s`}
          hint="Utilisé quand la phrase entière apparaît d’un coup"
        >
          <SliderControl
            value={animation.wordStagger}
            onChange={(wordStagger) => patchAnimation({ wordStagger })}
            min={0}
            max={0.3}
            step={0.005}
          />
        </Field>
        <Field label="Échelle de départ" value={`× ${animation.scaleFrom.toFixed(2)}`}>
          <SliderControl
            value={animation.scaleFrom}
            onChange={(scaleFrom) => patchAnimation({ scaleFrom })}
            min={0}
            max={1.5}
            step={0.01}
          />
        </Field>
        <Field label="Distance" value={`${Math.round(animation.distance)} px`}>
          <SliderControl
            value={animation.distance}
            onChange={(distance) => patchAnimation({ distance })}
            min={0}
            max={400}
            step={5}
            decimals={0}
          />
        </Field>
        <Field label="Rotation d’entrée" value={`${Math.round(animation.rotation)}°`}>
          <SliderControl
            value={animation.rotation}
            onChange={(rotation) => patchAnimation({ rotation })}
            min={-90}
            max={90}
            step={1}
            decimals={0}
          />
        </Field>
        <Field label="Flou de départ" value={`${animation.blurFrom.toFixed(1)} px`}>
          <SliderControl
            value={animation.blurFrom}
            onChange={(blurFrom) => patchAnimation({ blurFrom })}
            min={0}
            max={40}
            step={0.5}
          />
        </Field>
        <Field
          label="Mouvement du mot dit"
          hint="Continue tant que le mot est prononcé, après son entrée"
        >
          <SelectControl<ActiveMotionKind>
            value={animation.activeMotion}
            onChange={(activeMotion) => patchAnimation({ activeMotion })}
            options={ACTIVE_MOTIONS}
          />
        </Field>
        {animation.activeMotion !== 'none' && (
          <Field label="Amplitude" value={`× ${animation.activeMotionAmount.toFixed(2)}`}>
            <SliderControl
              value={animation.activeMotionAmount}
              onChange={(activeMotionAmount) => patchAnimation({ activeMotionAmount })}
              min={0}
              max={2}
              step={0.05}
            />
          </Field>
        )}
        <Field
          label="Inclinaison des mots"
          value={`± ${style.wordTilt.toFixed(1)}°`}
          hint="Chaque mot garde toujours le même angle"
        >
          <SliderControl
            value={style.wordTilt}
            onChange={(wordTilt) => patchStyle({ wordTilt })}
            min={0}
            max={20}
            step={0.5}
          />
        </Field>
      </Section>

      <Section title="Police" defaultOpen={false}>
        <Field label="Famille">
          <input
            className="input"
            value={style.fontFamily}
            onChange={(event) => patchStyle({ fontFamily: event.target.value })}
          />
        </Field>
        <Field label="Graisse">
          <div className="segmented">
            {[400, 600, 700, 800, 900].map((weight) => (
              <button
                key={weight}
                type="button"
                className={style.fontWeight === weight ? 'active' : ''}
                onClick={() => patchStyle({ fontWeight: weight })}
              >
                {weight}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Interlettrage" value={`${style.letterSpacing} px`}>
          <div className="field-row">
            <NumberControl
              value={style.letterSpacing}
              onChange={(letterSpacing) => patchStyle({ letterSpacing })}
              min={-20}
              max={60}
              step={0.5}
              decimals={1}
            />
          </div>
        </Field>
      </Section>
    </>
  );
}
