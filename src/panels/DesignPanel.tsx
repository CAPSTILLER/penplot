import { useRef } from 'react';
import { Num, Section, Segmented, Slider, Toggle } from '../components/Fields';
import type { OptimizeOptions } from '../lib/optimize';
import type { TraceMode } from '../lib/trace';

export type SourceKind = 'svg' | 'image' | 'text';

export interface Placement {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  mirror: boolean;
}

export interface ImageSettings {
  mode: TraceMode;
  threshold: number;
  invert: boolean;
  hatch: boolean;
  hatchSpacingMm: number;
  hatchAngle: number;
  detail: number;
  simplify: number;
}

export interface TextSettings {
  value: string;
  size: number;
  letterSpacing: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
}

interface Props {
  source: SourceKind;
  setSource: (s: SourceKind) => void;
  svgName: string | null;
  svgTol: number;
  setSvgTol: (v: number) => void;
  svgWarnings: string[];
  onSvgFile: (f: File) => void;
  imageName: string | null;
  imageBusy: boolean;
  imageError: string | null;
  img: ImageSettings;
  setImg: (p: Partial<ImageSettings>) => void;
  onImageFile: (f: File) => void;
  text: TextSettings;
  setText: (p: Partial<TextSettings>) => void;
  placement: Placement;
  setPlacement: (p: Partial<Placement>) => void;
  size: { w: number; h: number };
  fitMargin: number;
  setFitMargin: (v: number) => void;
  onFit: () => void;
  onCenter: () => void;
  opt: OptimizeOptions;
  setOpt: (p: Partial<OptimizeOptions>) => void;
  stats: { pathsBefore: number; pathsAfter: number; travelBefore: number; travelAfter: number };
  boundsMode: 'clip' | 'clamp';
  setBoundsMode: (m: 'clip' | 'clamp') => void;
  boundsMessage: string | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function DesignPanel(p: Props) {
  const svgInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const { placement: pl, size } = p;
  return (
    <div className="panel-body">
      <Section title="1 · Input">
        <Segmented
          label="Input type"
          value={p.source}
          onChange={p.setSource}
          options={[
            { value: 'svg', label: 'SVG' },
            { value: 'image', label: 'Image' },
            { value: 'text', label: 'Text' },
          ]}
        />
        {p.source === 'svg' && (
          <div className="stack">
            <input ref={svgInput} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onSvgFile(f); e.target.value = ''; }} />
            <button type="button" className="btn wide" onClick={() => svgInput.current?.click()}>
              {p.svgName ? `↻ Replace SVG (${p.svgName})` : '⬆ Open SVG file'}
            </button>
            <Slider label="Curve tolerance" value={p.svgTol} min={0.02} max={1} step={0.01} onChange={p.setSvgTol} format={(v) => `${v.toFixed(2)} mm`} />
            <p className="note">Paths, lines, polylines, polygons, rects, circles and ellipses. Transforms are respected; curves are flattened to within the tolerance. Convert text to paths in your editor first (or use the Text tab).</p>
            {p.svgWarnings.map((w) => <p key={w} className="warn">{w}</p>)}
          </div>
        )}
        {p.source === 'image' && (
          <div className="stack">
            <input ref={imgInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onImageFile(f); e.target.value = ''; }} />
            <button type="button" className="btn wide" onClick={() => imgInput.current?.click()} disabled={p.imageBusy}>
              {p.imageBusy ? 'Loading…' : p.imageName ? `↻ Replace image (${p.imageName})` : '⬆ Open photo / drawing'}
            </button>
            {p.imageError && <p className="warn">{p.imageError}</p>}
            <Segmented
              label="Trace mode"
              value={p.img.mode}
              onChange={(mode) => p.setImg({ mode })}
              options={[
                { value: 'centerline', label: 'Centerline' },
                { value: 'outline', label: 'Outline' },
                { value: 'edges', label: 'Edges' },
              ]}
            />
            <p className="note">
              {p.img.mode === 'centerline' && 'Best for pen/ink drawings: each dark line becomes a single stroke down its middle.'}
              {p.img.mode === 'outline' && 'Traces the contour around every dark area (pair with hatch fill to fill them in).'}
              {p.img.mode === 'edges' && 'Finds edges in photos (Sobel) and thins them to single strokes.'}
            </p>
            <Slider label={p.img.mode === 'edges' ? 'Edge sensitivity' : 'Threshold'} value={p.img.threshold} min={1} max={254} onChange={(threshold) => p.setImg({ threshold })} />
            <Slider label="Detail" value={p.img.detail} min={150} max={900} step={50} onChange={(detail) => p.setImg({ detail })} format={(v) => `${v} px`} />
            <Slider label="Smoothing" value={p.img.simplify} min={0} max={3} step={0.1} onChange={(simplify) => p.setImg({ simplify })} format={(v) => `${v.toFixed(1)} px`} />
            <Toggle label="Invert (light lines on dark)" checked={p.img.invert} onChange={(invert) => p.setImg({ invert })} />
            <Toggle label="Hatch fill dark areas" checked={p.img.hatch} onChange={(hatch) => p.setImg({ hatch })} />
            {p.img.hatch && (
              <div className="grid2">
                <Num label="Hatch spacing" unit="mm" value={p.img.hatchSpacingMm} min={0.3} max={20} step={0.1} onChange={(hatchSpacingMm) => p.setImg({ hatchSpacingMm })} />
                <Num label="Hatch angle" unit="°" value={p.img.hatchAngle} min={-90} max={90} step={15} onChange={(hatchAngle) => p.setImg({ hatchAngle })} />
              </div>
            )}
          </div>
        )}
        {p.source === 'text' && (
          <div className="stack">
            <textarea className="text-in" rows={3} value={p.text.value} onChange={(e) => p.setText({ value: e.target.value })} aria-label="Text to plot" spellCheck={false} />
            <div className="grid2">
              <Num label="Letter height" unit="mm" value={p.text.size} min={1} max={200} step={1} onChange={(size) => p.setText({ size })} />
              <Num label="Letter spacing" unit="mm" value={p.text.letterSpacing} min={-5} max={50} step={0.5} onChange={(letterSpacing) => p.setText({ letterSpacing })} />
              <Num label="Line spacing" unit="×" value={p.text.lineHeight} min={0.8} max={5} step={0.1} onChange={(lineHeight) => p.setText({ lineHeight })} />
            </div>
            <Segmented label="Alignment" value={p.text.align} onChange={(align) => p.setText({ align })} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} />
            <p className="note">Hershey single-stroke font: every letter is drawn once, not as an outline. Letter height sets the size before any scaling below.</p>
          </div>
        )}
      </Section>

      <Section title="2 · Place on bed" right={<span className="pill">{r1(size.w * pl.scale)} × {r1(size.h * pl.scale)} mm</span>}>
        <div className="grid2">
          <Num label="Center X" unit="mm" value={pl.x} step={1} onChange={(x) => p.setPlacement({ x })} decimals={1} />
          <Num label="Center Y" unit="mm" value={pl.y} step={1} onChange={(y) => p.setPlacement({ y })} decimals={1} />
          <Num label="Scale" unit="%" value={pl.scale * 100} min={1} max={10000} step={5} onChange={(v) => p.setPlacement({ scale: v / 100 })} decimals={1} />
          <Num label="Width" unit="mm" value={size.w * pl.scale} min={1} max={2000} step={1} decimals={1} onChange={(w) => size.w > 0 && p.setPlacement({ scale: w / size.w })} />
        </div>
        <Slider label="Rotation" value={pl.rotation} min={-180} max={180} step={1} onChange={(rotation) => p.setPlacement({ rotation })} format={(v) => `${v}°`} />
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => p.setPlacement({ rotation: ((pl.rotation + 270) % 360) - 180 })}>⟲ 90°</button>
          <button type="button" className="btn" onClick={() => p.setPlacement({ rotation: ((pl.rotation + 450) % 360) - 180 })}>⟳ 90°</button>
          <button type="button" className="btn" onClick={() => p.setPlacement({ mirror: !pl.mirror })}>{pl.mirror ? '⇋ Mirrored' : '⇋ Mirror'}</button>
          <button type="button" className="btn" onClick={p.onCenter}>✛ Center</button>
        </div>
        <div className="fit-row">
          <button type="button" className="btn gold" onClick={p.onFit}>⤢ Fit to area</button>
          <Num label="Margin" unit="mm" value={p.fitMargin} min={0} max={80} step={1} onChange={p.setFitMargin} />
        </div>
        <Segmented
          label="Out of bounds"
          value={p.boundsMode}
          onChange={p.setBoundsMode}
          options={[{ value: 'clip', label: 'Clip outside parts' }, { value: 'clamp', label: 'Clamp to edge' }]}
        />
        {p.boundsMessage && <p className="warn">{p.boundsMessage}</p>}
      </Section>

      <Section title="3 · Optimize pen moves">
        <div className="stats-row">
          <div><b>{p.stats.pathsAfter}</b><span>strokes{p.stats.pathsBefore !== p.stats.pathsAfter ? ` (from ${p.stats.pathsBefore})` : ''}</span></div>
          <div><b>{Math.round(p.stats.travelAfter)} mm</b><span>pen-up travel{p.stats.travelBefore > 0 ? ` (was ${Math.round(p.stats.travelBefore)})` : ''}</span></div>
        </div>
        <Toggle label="Reorder strokes (nearest neighbour)" checked={p.opt.reorder} onChange={(reorder) => p.setOpt({ reorder })} />
        <Toggle label="Allow drawing strokes backwards" checked={p.opt.allowReverse} onChange={(allowReverse) => p.setOpt({ allowReverse })} />
        <Toggle label="Start loops at the nearest point" checked={p.opt.rotateLoops} onChange={(rotateLoops) => p.setOpt({ rotateLoops })} />
        <Toggle label="Merge strokes whose ends touch" checked={p.opt.mergeTolerance > 0} onChange={(v) => p.setOpt({ mergeTolerance: v ? 0.05 : 0 })} />
        <div className="grid2">
          {p.opt.mergeTolerance > 0 && <Num label="Merge gap" unit="mm" value={p.opt.mergeTolerance} min={0.001} max={2} step={0.05} onChange={(mergeTolerance) => p.setOpt({ mergeTolerance })} />}
          <Num label="Drop segments under" unit="mm" value={p.opt.minSegment} min={0} max={5} step={0.05} onChange={(minSegment) => p.setOpt({ minSegment })} />
          <Num label="Drop strokes under" unit="mm" value={p.opt.minPathLength} min={0} max={20} step={0.1} onChange={(minPathLength) => p.setOpt({ minPathLength })} />
        </div>
      </Section>
    </div>
  );
}
