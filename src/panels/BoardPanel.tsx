import { Num, Section, Segmented, Slider, Toggle } from '../components/Fields';
import { type GridOptions, type Instance, PAPER_SIZES, type PaperPreset, type PaperSettings, type RawSize, instanceSize, normDeg, paperSize } from '../lib/board';

interface Props {
  instances: Instance[];
  selected: Instance | null;
  select: (id: string) => void;
  raw: RawSize;
  setSelected: (next: Instance) => void;
  resize: (change: { width: number } | { height: number } | { percent: number }) => void;
  lock: boolean;
  setLock: (v: boolean) => void;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAdd: () => void;
  canPaste: boolean;
  fitMargin: number;
  setFitMargin: (v: number) => void;
  onFit: () => void;
  onCenter: () => void;
  grid: GridOptions;
  setGrid: (p: Partial<GridOptions>) => void;
  onMakeGrid: () => void;
  paper: PaperSettings;
  setPaper: (p: Partial<PaperSettings>) => void;
  onCenterPaper: () => void;
  regionLabel: string;
  boundsMode: 'clip' | 'clamp';
  setBoundsMode: (m: 'clip' | 'clamp') => void;
  boundsMessage: string | null;
  badIndexes: number[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl+';

export function BoardPanel(p: Props) {
  const sel = p.selected;
  const size = sel ? instanceSize(sel, p.raw) : { w: 0, h: 0 };
  const ps = paperSize(p.paper);
  return (
    <>
      <Section title="2 · Copies on the board" right={<span className="pill">{p.instances.length} {p.instances.length === 1 ? 'copy' : 'copies'}</span>}>
        <div className="inst-chips" role="listbox" aria-label="Copies">
          {p.instances.map((inst, i) => (
            <button
              key={inst.id}
              type="button"
              role="option"
              aria-selected={sel?.id === inst.id}
              className={`inst-chip${sel?.id === inst.id ? ' on' : ''}${p.badIndexes.includes(i + 1) ? ' bad' : ''}`}
              onClick={() => p.select(inst.id)}
            >
              {i + 1}
            </button>
          ))}
          {!p.instances.length && <span className="note">No copies on the board.</span>}
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={p.onCopy} disabled={!sel} title={`Copy (${mod}C)`}>⧉ Copy</button>
          <button type="button" className="btn" onClick={p.onPaste} disabled={!p.canPaste} title={`Paste (${mod}V)`}>⎘ Paste</button>
          <button type="button" className="btn" onClick={p.onDuplicate} disabled={!sel} title={`Duplicate (${mod}D)`}>＋ Duplicate</button>
          <button type="button" className="btn danger" onClick={p.onDelete} disabled={!sel} title="Delete (Del)">✕ Delete</button>
        </div>
        {!p.instances.length && <button type="button" className="btn gold wide" onClick={p.onAdd}>＋ Add the design to the board</button>}
        <p className="note">Tap a copy on the preview to select it and drag to move it. Drag a gold corner to scale and the ⟳ knob to rotate. Desktop shortcuts: {mod}C, {mod}V, {mod}D, Delete, and the arrow keys to nudge (hold Shift for 10 mm).</p>
      </Section>

      {sel && (
        <Section title={`Copy ${p.instances.findIndex((i) => i.id === sel.id) + 1} · size & position`} right={<span className="pill">{r1(size.w)} × {r1(size.h)} mm</span>}>
          <div className="grid2">
            <Num label="Width" unit="mm" value={size.w} min={0.5} max={5000} step={1} decimals={1} onChange={(width) => p.resize({ width })} />
            <Num label="Height" unit="mm" value={size.h} min={0.5} max={5000} step={1} decimals={1} onChange={(height) => p.resize({ height })} />
          </div>
          <div className="grid2 align-end">
            <Toggle label="Lock aspect ratio" checked={p.lock} onChange={p.setLock} />
            <Num label="Scale" unit="%" value={sel.scale * 100} min={0.1} max={100000} step={5} decimals={1} onChange={(percent) => p.resize({ percent })} hint={Math.abs(sel.scale - sel.scaleY) > 1e-9 ? `stretched: Y ${r1(sel.scaleY * 100)}%` : undefined} />
            <Num label="Center X" unit="mm" value={sel.x} step={1} onChange={(x) => p.setSelected({ ...sel, x })} decimals={1} />
            <Num label="Center Y" unit="mm" value={sel.y} step={1} onChange={(y) => p.setSelected({ ...sel, y })} decimals={1} />
          </div>
          <Slider label="Rotation" value={sel.rotation} min={-180} max={180} step={1} onChange={(rotation) => p.setSelected({ ...sel, rotation })} format={(v) => `${v}°`} />
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => p.setSelected({ ...sel, rotation: normDeg(sel.rotation + 90) })}>⟲ 90°</button>
            <button type="button" className="btn" onClick={() => p.setSelected({ ...sel, rotation: normDeg(sel.rotation - 90) })}>⟳ 90°</button>
            <button type="button" className="btn" onClick={() => p.setSelected({ ...sel, mirror: !sel.mirror })}>{sel.mirror ? '⇋ Mirrored' : '⇋ Mirror'}</button>
            <button type="button" className="btn" onClick={p.onCenter}>✛ Center</button>
          </div>
          <div className="fit-row">
            <button type="button" className="btn gold" onClick={p.onFit}>⤢ Fit to {p.paper.preset !== 'none' ? 'paper' : 'area'}</button>
            <Num label="Margin" unit="mm" value={p.fitMargin} min={0} max={80} step={1} onChange={p.setFitMargin} />
          </div>
        </Section>
      )}

      <Section title="Repeat / grid">
        <div className="grid2">
          <Num label="Rows" value={p.grid.rows} min={1} max={50} step={1} decimals={0} onChange={(rows) => p.setGrid({ rows: Math.round(rows) })} />
          <Num label="Columns" value={p.grid.cols} min={1} max={50} step={1} decimals={0} onChange={(cols) => p.setGrid({ cols: Math.round(cols) })} />
          <Num label="Gap X" unit="mm" value={p.grid.gapX} min={0} max={200} step={1} onChange={(gapX) => p.setGrid({ gapX })} />
          <Num label="Gap Y" unit="mm" value={p.grid.gapY} min={0} max={200} step={1} onChange={(gapY) => p.setGrid({ gapY })} />
        </div>
        <Toggle label={`Auto-fit copies to the ${p.paper.preset !== 'none' ? 'paper' : 'bed'}`} checked={p.grid.autoFit} onChange={(autoFit) => p.setGrid({ autoFit })} hint={p.grid.autoFit ? `Uses the margin above. Region: ${p.regionLabel}` : 'Keeps the selected copy\u2019s size and centres the grid.'} />
        <button type="button" className="btn gold wide" onClick={p.onMakeGrid} disabled={!sel && !p.instances.length}>
          ▦ Make {p.grid.rows} × {p.grid.cols} grid ({p.grid.rows * p.grid.cols} copies)
        </button>
        <p className="note">This replaces the copies on the board with a grid of the selected copy (same rotation, mirror and aspect ratio).</p>
      </Section>

      <Section title="Paper" right={ps ? <span className="pill">{r1(ps.w)} × {r1(ps.h)} mm</span> : undefined}>
        <select className="select" value={p.paper.preset} onChange={(e) => p.setPaper({ preset: e.target.value as PaperPreset })} aria-label="Paper size">
          <option value="none">No paper outline</option>
          {Object.entries(PAPER_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label} ({v.w} × {v.h} mm)</option>)}
          <option value="custom">Custom size</option>
        </select>
        {p.paper.preset !== 'none' && (
          <>
            {p.paper.preset === 'custom' && (
              <div className="grid2">
                <Num label="Paper width" unit="mm" value={p.paper.customW} min={10} max={2000} step={1} onChange={(customW) => p.setPaper({ customW })} />
                <Num label="Paper height" unit="mm" value={p.paper.customH} min={10} max={2000} step={1} onChange={(customH) => p.setPaper({ customH })} />
              </div>
            )}
            <Segmented label="Orientation" value={p.paper.landscape ? 'l' : 'p'} onChange={(v) => p.setPaper({ landscape: v === 'l' })} options={[{ value: 'p', label: 'Portrait' }, { value: 'l', label: 'Landscape' }]} />
            <div className="grid2">
              <Num label="Paper origin X" unit="mm" value={p.paper.originX} step={1} onChange={(originX) => p.setPaper({ originX })} hint="front-left corner on the bed" />
              <Num label="Paper origin Y" unit="mm" value={p.paper.originY} step={1} onChange={(originY) => p.setPaper({ originY })} />
            </div>
            <button type="button" className="btn wide" onClick={p.onCenterPaper}>✛ Center paper on the bed</button>
            <p className="note">The paper is drawn as an outline on the bed. Fit and grid auto-fit use the part of the paper the pen can reach. A sheet bigger than the 220 mm bed only gets plotted where it overlaps the bed.</p>
          </>
        )}
      </Section>

      <Section title="Out of reach">
        <Segmented label="Out of bounds" value={p.boundsMode} onChange={p.setBoundsMode} options={[{ value: 'clip', label: 'Clip outside parts' }, { value: 'clamp', label: 'Clamp to edge' }]} />
        {p.boundsMessage && <p className="warn">{p.boundsMessage}</p>}
      </Section>
    </>
  );
}
