import { useRef, useState } from 'react';
import { ColorPicker } from './ColorPicker';
import { Field } from '../ui/Field';
import { useLayerValue } from '@/state/hooks';
import { useStore } from '@/state/store';

interface ColorSwatchProps {
  value: string;
  onChange: (value: string) => void;
  title?: string;
}

export function ColorSwatch({ value, onChange, title }: ColorSwatchProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="swatch"
        title={title ?? value}
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setAnchor({ x: rect.right, y: rect.bottom + 6 });
          setOpen((v) => !v);
        }}
      >
        <span className="swatch-fill" style={{ background: value }} />
      </button>
      {open && (
        <ColorPicker
          value={value}
          onChange={onChange}
          onClose={() => setOpen(false)}
          anchor={anchor}
        />
      )}
    </>
  );
}

interface ColorFieldProps {
  path: string;
  label: string;
}

/** Colour row bound to a layer property, with its keyframe button. */
export function ColorField({ path, label }: ColorFieldProps) {
  const value = useLayerValue<string>(path) ?? '#000000';
  const patchLayer = useStore((state) => state.patchLayer);

  return (
    <Field label={label} path={path}>
      <div className="field-row">
        <ColorSwatch
          value={value}
          onChange={(color) => patchLayer(path, color, { commitKey: path })}
        />
        <input
          className="input"
          value={value}
          spellCheck={false}
          onChange={(event) => patchLayer(path, event.target.value, { commitKey: path })}
        />
      </div>
    </Field>
  );
}
