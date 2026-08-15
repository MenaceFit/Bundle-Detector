import type { ReactNode } from 'react';
import { useKeyframeStatus } from '@/state/hooks';
import { useStore } from '@/state/store';
import { getProperty } from '@/animation/properties';

interface KeyframeButtonProps {
  path: string;
}

/**
 * Stopwatch button shown next to every animatable property: click at the
 * playhead to create a keyframe with the current value, click again on an
 * existing one to remove it.
 */
export function KeyframeButton({ path }: KeyframeButtonProps) {
  const status = useKeyframeStatus(path);
  const toggleKeyframe = useStore((state) => state.toggleKeyframe);

  const classes = ['kf-btn'];
  if (status.animated) classes.push('animated');
  if (status.onKeyframe) classes.push('on');

  return (
    <button
      type="button"
      className={classes.join(' ')}
      onClick={() => toggleKeyframe(path)}
      title={
        status.onKeyframe
          ? 'Supprimer le keyframe à cet instant'
          : status.animated
            ? 'Ajouter un keyframe à cet instant'
            : 'Animer cette propriété'
      }
    />
  );
}

interface FieldProps {
  label: string;
  /** Dotted property path; when animatable it gets a keyframe button. */
  path?: string;
  value?: ReactNode;
  hint?: string;
  children: ReactNode;
}

export function Field({ label, path, value, hint, children }: FieldProps) {
  const animatable = path !== undefined && getProperty(path) !== undefined;

  return (
    <div className="field">
      <div className="field-head">
        {animatable && path && <KeyframeButton path={path} />}
        <span className="field-label" title={hint ?? label}>
          {label}
        </span>
        {value !== undefined && <span className="field-value">{value}</span>}
      </div>
      {children}
    </div>
  );
}
