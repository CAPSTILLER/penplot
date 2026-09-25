import { type ReactNode, useEffect, useId, useState } from 'react';

interface NumProps {
  label: ReactNode;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  hint?: ReactNode;
  decimals?: number;
}

/** Number input that lets you type freely and commits valid numbers. */
export function Num({ label, value, onChange, step = 1, min, max, unit, hint, decimals = 3 }: NumProps) {
  const id = useId();
  const show = (v: number) => String(Math.round(v * 10 ** decimals) / 10 ** decimals);
  const [text, setText] = useState(show(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(show(value));
  }, [value, focus]);
  const commit = (t: string) => {
    const v = parseFloat(t.replace(',', '.'));
    if (!Number.isFinite(v)) return;
    let c = v;
    if (min !== undefined) c = Math.max(min, c);
    if (max !== undefined) c = Math.min(max, c);
    if (c !== value) onChange(c);
  };
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="num-wrap">
        <input
          id={id}
          className="num"
          type="text"
          inputMode="decimal"
          value={text}
          onFocus={() => setFocus(true)}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value.replace(',', '.'));
            if (Number.isFinite(v) && (min === undefined || v >= min) && (max === undefined || v <= max)) onChange(v);
          }}
          onBlur={(e) => { setFocus(false); commit(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const n = Math.round((value + (e.key === 'ArrowUp' ? step : -step)) * 1e6) / 1e6;
              const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
              onChange(c);
              setText(show(c));
            }
          }}
        />
        {unit && <span className="unit">{unit}</span>}
      </span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

interface SliderProps {
  label: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
}

export function Slider({ label, value, onChange, min, max, step = 1, format }: SliderProps) {
  const id = useId();
  return (
    <label className="field slider" htmlFor={id}>
      <span className="field-label">
        {label} <b className="slider-val">{format ? format(value) : value}</b>
      </span>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span className="toggle-knob" /></span>
      <span className="toggle-label">{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'seg-btn on' : 'seg-btn'} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, right }: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}
