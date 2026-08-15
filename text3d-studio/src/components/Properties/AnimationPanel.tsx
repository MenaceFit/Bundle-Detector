import { useState } from 'react';
import { Section } from '../ui/Section';
import { Field } from '../ui/Field';
import { SelectField, SliderField, ToggleField, Segmented, SliderControl } from '../ui/Controls';
import { useActiveLayer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { ANIMATION_PRESET_LIST } from '@/animation/presets';
import { EASING_KINDS, EASING_LABELS } from '@/animation/easing';
import type { AnimationPresetDefinition } from '@/types';

const CATEGORIES: Array<{ value: AnimationPresetDefinition['category']; label: string }> = [
  { value: 'in', label: 'Entrées' },
  { value: 'out', label: 'Sorties' },
  { value: 'loop', label: 'Boucles' },
  { value: '3d', label: '3D' },
];

export function AnimationPanel() {
  const layer = useActiveLayer();
  const timeline = useStore((state) => state.project.timeline);
  const setTimeline = useStore((state) => state.setTimeline);
  const applyAnimationPreset = useStore((state) => state.applyAnimationPreset);
  const clearAnimation = useStore((state) => state.clearAnimation);
  const notify = useStore((state) => state.notify);
  const patchLayer = useStore((state) => state.patchLayer);

  const [category, setCategory] = useState<AnimationPresetDefinition['category']>('in');
  const perLetter = layer.animation.perLetter;
  const trackCount = layer.animation.tracks.length;
  const keyframeCount = layer.animation.tracks.reduce((sum, t) => sum + t.keyframes.length, 0);

  return (
    <>
      <Section title="Timeline">
        <Field label="Durée" value={`${timeline.duration.toFixed(1)} s`}>
          <SliderControl
            value={timeline.duration}
            onChange={(value) => setTimeline({ duration: value })}
            min={0.2}
            max={30}
            step={0.1}
          />
          <div className="anim-list" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 6 }}>
            {[0.5, 1, 2, 3, 5, 10, 20].map((value) => (
              <button
                key={value}
                type="button"
                className={`anim-btn${Math.abs(timeline.duration - value) < 0.01 ? ' active' : ''}`}
                style={{ textAlign: 'center' }}
                onClick={() => setTimeline({ duration: value })}
              >
                {value}s
              </button>
            ))}
          </div>
        </Field>

        <Field label="Images par seconde">
          <Segmented
            value={String(timeline.fps)}
            options={[
              { value: '24', label: '24' },
              { value: '30', label: '30' },
              { value: '60', label: '60' },
            ]}
            onChange={(value) => setTimeline({ fps: Number(value) })}
          />
        </Field>

        <div className="field-head">
          <span className="field-label">Lecture en boucle</span>
          <button
            type="button"
            className={`switch${timeline.loop ? ' on' : ''}`}
            onClick={() => setTimeline({ loop: !timeline.loop })}
          />
        </div>

        <p className="hint">
          {trackCount} piste{trackCount > 1 ? 's' : ''} · {keyframeCount} keyframe
          {keyframeCount > 1 ? 's' : ''}
        </p>
      </Section>

      <Section title="Animations prédéfinies">
        <Segmented value={category} options={CATEGORIES} onChange={setCategory} />
        <div className="anim-list">
          {ANIMATION_PRESET_LIST.filter((preset) => preset.category === category).map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="anim-btn"
              title={preset.description}
              onClick={() => {
                applyAnimationPreset(preset.id);
                notify('success', `Animation « ${preset.name} » appliquée`);
              }}
            >
              {preset.name}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => {
            clearAnimation();
            notify('info', 'Animation effacée');
          }}
          disabled={trackCount === 0}
        >
          Effacer toute l’animation
        </button>
      </Section>

      <Section title="Animation par lettre">
        <ToggleField path="animation.perLetter.enabled" label="Activer" />
        {perLetter.enabled && (
          <>
            <SelectField
              path="animation.perLetter.animation"
              label="Animation"
              options={[
                { value: 'fade', label: 'Fade' },
                { value: 'scale', label: 'Scale' },
                { value: 'pop', label: 'Pop' },
                { value: 'rotate', label: 'Rotation' },
                { value: 'slideUp', label: 'Slide Up' },
                { value: 'slideDown', label: 'Slide Down' },
                { value: 'slideLeft', label: 'Slide Left' },
                { value: 'slideRight', label: 'Slide Right' },
                { value: 'bounce', label: 'Bounce' },
                { value: 'blur', label: 'Blur' },
                { value: 'flip3d', label: '3D Flip' },
              ]}
            />
            <SelectField
              path="animation.perLetter.order"
              label="Ordre"
              options={[
                { value: 'normal', label: 'Normal' },
                { value: 'reverse', label: 'Inversé' },
                { value: 'random', label: 'Aléatoire' },
                { value: 'center', label: 'Depuis le centre' },
                { value: 'edges', label: 'Depuis les bords' },
              ]}
            />
            <SliderField
              path="animation.perLetter.delay"
              label="Décalage (stagger)"
              min={0}
              max={0.6}
              step={0.005}
              unit=" s"
              decimals={3}
            />
            <SliderField
              path="animation.perLetter.duration"
              label="Durée par lettre"
              min={0.05}
              max={3}
              step={0.01}
              unit=" s"
              decimals={2}
            />
            <SliderField
              path="animation.perLetter.startTime"
              label="Début"
              min={0}
              max={Math.max(1, timeline.duration)}
              step={0.01}
              unit=" s"
              decimals={2}
            />
            <Field label="Interpolation">
              <select
                className="input"
                value={perLetter.easing}
                onChange={(event) => patchLayer('animation.perLetter.easing', event.target.value)}
              >
                {EASING_KINDS.filter((kind) => kind !== 'bezier' && kind !== 'hold').map((kind) => (
                  <option key={kind} value={kind}>
                    {EASING_LABELS[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <SliderField
              path="animation.perLetter.distance"
              label="Distance"
              min={0}
              max={800}
              step={5}
              unit=" px"
              decimals={0}
            />
            <SliderField
              path="animation.perLetter.rotation"
              label="Rotation initiale"
              min={-360}
              max={360}
              step={1}
              unit="°"
              decimals={0}
            />
            <SliderField path="animation.perLetter.scale" label="Échelle initiale" min={0} max={2} step={0.01} />
            <SliderField
              path="animation.perLetter.blur"
              label="Flou initial"
              min={0}
              max={60}
              step={0.5}
              unit=" px"
              decimals={1}
            />
            <SliderField
              path="animation.perLetter.seed"
              label="Graine (ordre aléatoire)"
              min={1}
              max={9999}
              step={1}
              decimals={0}
            />
          </>
        )}
      </Section>
    </>
  );
}
