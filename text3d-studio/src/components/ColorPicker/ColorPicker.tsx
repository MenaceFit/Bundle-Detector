import { useEffect, useMemo, useRef, useState } from 'react';
import { hslToRgb, parseColor, rgbToHsl, toCss, toHex } from '@/utils/color';
import { readJson, STORAGE_KEYS, writeJson } from '@/project/storage';
import { clamp } from '@/utils/math';
import { createLogger } from '@/utils/logger';

const log = createLogger('color');

interface ColorPickerProps {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  anchor: { x: number; y: number };
}

/** EyeDropper is Chromium-only and needs a user gesture; feature-detected. */
interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}

export function ColorPicker({ value, onChange, onClose, anchor }: ColorPickerProps) {
  const rgba = useMemo(() => parseColor(value), [value]);
  const [hsl, setHsl] = useState(() => rgbToHsl(rgba));
  const [hex, setHex] = useState(() => toHex(rgba, rgba.a < 1));
  const [history, setHistory] = useState<string[]>(() =>
    readJson<string[]>(STORAGE_KEYS.colorHistory, []),
  );
  const [favorites, setFavorites] = useState<string[]>(() =>
    readJson<string[]>(STORAGE_KEYS.colorFavorites, []),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);

  // Re-sync when the owner changes the colour from outside (keyframes, presets).
  useEffect(() => {
    const next = parseColor(value);
    setHsl(rgbToHsl(next));
    setHex(toHex(next, next.a < 1));
  }, [value]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    // Defer so the click that opened the picker does not immediately close it.
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onPointerDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const emit = (next: { h: number; s: number; l: number; a: number }): void => {
    setHsl(next);
    const color = toHex(hslToRgb(next), next.a < 1);
    setHex(color);
    onChange(color);
  };

  const commitToHistory = (color: string): void => {
    const next = [color, ...history.filter((c) => c !== color)].slice(0, 18);
    setHistory(next);
    writeJson(STORAGE_KEYS.colorHistory, next);
  };

  const pickFromArea = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    // Standard HSV square mapped onto our HSL model.
    const v = 1 - y;
    const sv = x;
    const l = (v * (2 - sv)) / 2;
    const s = l === 0 || l === 1 ? 0 : (v * sv) / (1 - Math.abs(2 * l - 1));
    emit({ ...hsl, s: clamp(s, 0, 1), l: clamp(l, 0, 1) });
  };

  const useEyeDropper = async (): Promise<void> => {
    const factory = (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
    if (!factory) return;
    try {
      const result = await new factory().open();
      const next = rgbToHsl(parseColor(result.sRGBHex));
      emit({ ...next, a: hsl.a });
      commitToHistory(result.sRGBHex);
    } catch (error) {
      log.debug('Pipette annulée', error);
    }
  };

  const hasEyeDropper = typeof (window as { EyeDropper?: unknown }).EyeDropper === 'function';
  const pure = toCss(hslToRgb({ h: hsl.h, s: 1, l: 0.5, a: 1 }));
  const cursorV = hsl.l + hsl.s * Math.min(hsl.l, 1 - hsl.l);
  const cursorS = cursorV === 0 ? 0 : 2 * (1 - hsl.l / cursorV);

  const style: React.CSSProperties = {
    left: clamp(anchor.x - 236, 8, window.innerWidth - 244),
    top: clamp(anchor.y, 8, Math.max(8, window.innerHeight - 420)),
  };

  return (
    <div className="popover" ref={panelRef} style={style}>
      <div
        className="sv-area"
        ref={areaRef}
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})`,
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pickFromArea(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) pickFromArea(event);
        }}
        onPointerUp={() => commitToHistory(hex)}
      >
        <div
          className="sv-cursor"
          style={{ left: `${cursorS * 100}%`, top: `${(1 - cursorV) * 100}%` }}
        />
      </div>

      <input
        className="hue-slider"
        type="range"
        min={0}
        max={360}
        step={1}
        value={Math.round(hsl.h)}
        onChange={(event) => emit({ ...hsl, h: Number(event.target.value) })}
      />

      <input
        className="alpha-slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={hsl.a}
        style={{
          background: `linear-gradient(to right, transparent, ${toCss(hslToRgb({ ...hsl, a: 1 }))}), repeating-conic-gradient(#555 0% 25%, #888 0% 50%) 50% / 8px 8px`,
        }}
        onChange={(event) => emit({ ...hsl, a: Number(event.target.value) })}
      />

      <div className="field-row">
        <input
          className="input"
          value={hex}
          spellCheck={false}
          onChange={(event) => {
            setHex(event.target.value);
            const parsed = parseColor(event.target.value);
            if (event.target.value.trim().length >= 4) {
              setHsl(rgbToHsl(parsed));
              onChange(toHex(parsed, parsed.a < 1));
            }
          }}
          onBlur={() => commitToHistory(hex)}
        />
        {hasEyeDropper && (
          <button
            type="button"
            className="btn btn-icon btn-sm"
            title="Pipette"
            onClick={() => void useEyeDropper()}
          >
            ⌖
          </button>
        )}
        <button
          type="button"
          className="btn btn-icon btn-sm"
          title={favorites.includes(hex) ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          onClick={() => {
            const next = favorites.includes(hex)
              ? favorites.filter((c) => c !== hex)
              : [hex, ...favorites].slice(0, 18);
            setFavorites(next);
            writeJson(STORAGE_KEYS.colorFavorites, next);
          }}
        >
          {favorites.includes(hex) ? '★' : '☆'}
        </button>
      </div>

      <RgbRow rgba={hslToRgb(hsl)} onChange={(next) => emit({ ...rgbToHsl(next), a: hsl.a })} />

      {favorites.length > 0 && (
        <Swatches title="Favoris" colors={favorites} onPick={(color) => emit(rgbToHsl(parseColor(color)))} />
      )}
      {history.length > 0 && (
        <Swatches title="Récents" colors={history} onPick={(color) => emit(rgbToHsl(parseColor(color)))} />
      )}
    </div>
  );
}

function RgbRow({
  rgba,
  onChange,
}: {
  rgba: { r: number; g: number; b: number; a: number };
  onChange: (value: { r: number; g: number; b: number; a: number }) => void;
}) {
  const channels: Array<['r' | 'g' | 'b', string]> = [
    ['r', 'R'],
    ['g', 'G'],
    ['b', 'B'],
  ];
  return (
    <div className="field-row">
      {channels.map(([key, label]) => (
        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
          <span style={{ color: 'var(--text-2)', fontSize: 11 }}>{label}</span>
          <input
            className="input input-num"
            style={{ width: '100%' }}
            type="number"
            min={0}
            max={255}
            value={Math.round(rgba[key])}
            onChange={(event) =>
              onChange({ ...rgba, [key]: clamp(Number(event.target.value), 0, 255) })
            }
          />
        </label>
      ))}
    </div>
  );
}

function Swatches({
  title,
  colors,
  onPick,
}: {
  title: string;
  colors: string[];
  onPick: (color: string) => void;
}) {
  return (
    <div>
      <div className="hint" style={{ marginBottom: 4 }}>
        {title}
      </div>
      <div className="swatch-grid">
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            style={{ background: color }}
            onClick={() => onPick(color)}
          />
        ))}
      </div>
    </div>
  );
}
