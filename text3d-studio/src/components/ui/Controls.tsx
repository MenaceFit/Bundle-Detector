import { useEffect, useState, type ChangeEvent } from 'react';
import { Field } from './Field';
import { useLayerValue } from '@/state/hooks';
import { useStore } from '@/state/store';
import { clamp, roundTo } from '@/utils/math';

/* ------------------------------------------------------------ primitives */

interface SliderControlProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
}

export function SliderControl({
  value,
  onChange,
  min,
  max,
  step = 1,
  decimals = 2,
}: SliderControlProps) {
  return (
    <div className="field-row">
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <NumberControl
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        decimals={decimals}
      />
    </div>
  );
}

interface NumberControlProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
}

/**
 * Numeric input that keeps the typed text while it is being edited, so typing
 * "-" or "0." does not get clamped away mid-keystroke.
 */
export function NumberControl({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  decimals = 2,
}: NumberControlProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? String(Number.isFinite(value) ? roundTo(value, decimals) : 0);

  const commit = (raw: string): void => {
    const parsed = Number(raw.replace(',', '.'));
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    onChange(clamp(parsed, min, max));
  };

  return (
    <input
      className="input input-num"
      type="text"
      inputMode="decimal"
      value={display}
      step={step}
      onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setDraft(null);
          event.currentTarget.blur();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
          setDraft(null);
          onChange(clamp((Number.isFinite(value) ? value : 0) + delta, min, max));
        }
      }}
    />
  );
}

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={`switch${value ? ' on' : ''}`}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    />
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={option.value === value ? 'active' : ''}
          title={option.title ?? option.label}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface SelectControlProps<T extends string> {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}

export function SelectControl<T extends string>({
  value,
  options,
  onChange,
}: SelectControlProps<T>) {
  return (
    <select className="input" value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/* --------------------------------------------------- layer-bound fields */

function usePatch(path: string): (value: unknown) => void {
  const patchLayer = useStore((state) => state.patchLayer);
  return (value: unknown) => patchLayer(path, value, { commitKey: path });
}

interface SliderFieldProps {
  path: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  decimals?: number;
}

export function SliderField({
  path,
  label,
  min,
  max,
  step = 1,
  unit = '',
  decimals = 2,
}: SliderFieldProps) {
  const value = useLayerValue<number>(path) ?? 0;
  const patch = usePatch(path);

  return (
    <Field label={label} path={path} value={`${roundTo(value, decimals)}${unit}`}>
      <SliderControl
        value={value}
        onChange={patch}
        min={min}
        max={max}
        step={step}
        decimals={decimals}
      />
    </Field>
  );
}

export function ToggleField({ path, label }: { path: string; label: string }) {
  const value = useLayerValue<boolean>(path) ?? false;
  const patch = usePatch(path);

  return (
    <div className="field-head">
      <span className="field-label">{label}</span>
      <Toggle value={value} onChange={patch} />
    </div>
  );
}

interface SelectFieldProps<T extends string> {
  path: string;
  label: string;
  options: Array<{ value: T; label: string }>;
}

export function SelectField<T extends string>({ path, label, options }: SelectFieldProps<T>) {
  const value = useLayerValue<T>(path);
  const patch = usePatch(path);

  return (
    <Field label={label} path={path}>
      <SelectControl value={value} options={options} onChange={patch} />
    </Field>
  );
}

interface SegmentedFieldProps<T extends string> {
  path: string;
  label: string;
  options: Array<{ value: T; label: string; title?: string }>;
}

export function SegmentedField<T extends string>({ path, label, options }: SegmentedFieldProps<T>) {
  const value = useLayerValue<T>(path);
  const patch = usePatch(path);

  return (
    <Field label={label} path={path}>
      <Segmented value={value} options={options} onChange={patch} />
    </Field>
  );
}

/** Text input bound to a layer path, debounced through the history coalescer. */
export function TextField({ path, label }: { path: string; label: string }) {
  const value = useLayerValue<string>(path) ?? '';
  const patch = usePatch(path);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <Field label={label} path={path}>
      <input
        className="input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          patch(event.target.value);
        }}
      />
    </Field>
  );
}
