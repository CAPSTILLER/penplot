import { useState } from 'react';
import { Num, Section, Segmented } from '../components/Fields';
import type { HeightSquare } from '../lib/calibration';
import { fmt } from '../lib/gcode';
import type { Profile } from '../lib/profile';

export interface CalibSettings {
  mode: 'height' | 'offset';
  startZ: number;
  step: number;
  count: number;
  size: number;
  gap: number;
  cy: number;
  squareSize: number;
  crossArm: number;
}

interface Props {
  c: CalibSettings;
  setC: (p: Partial<CalibSettings>) => void;
  profile: Profile;
  squares: HeightSquare[];
  selected: number | null;
  onPick: (index: number) => void;
  onSetOffset: (x: number, y: number) => void;
}

export function CalibratePanel({ c, setC, profile, squares, selected, onPick, onSetOffset }: Props) {
  const cx = profile.bedW / 2, cy = profile.bedH / 2;
  const cmdX = cx - profile.penOffsetX, cmdY = cy - profile.penOffsetY;
  const [readX, setReadX] = useState(cmdX);
  const [readY, setReadY] = useState(cmdY);
  const [errX, setErrX] = useState(0);
  const [errY, setErrY] = useState(0);
  const lowest = squares.length ? squares[squares.length - 1].z : c.startZ;
  return (
    <div className="panel-body">
      <Segmented
        label="Calibration test"
        value={c.mode}
        onChange={(mode) => setC({ mode })}
        options={[{ value: 'height', label: 'Pen height' }, { value: 'offset', label: 'Pen offset' }]}
      />
      {c.mode === 'height' ? (
        <>
          <Section title="Pen-height test">
            <ol className="steps">
              <li><b>Level the bed first</b> (paper-under-nozzle at all four corners). With no spring, a tilted bed means light lines on one side and a dragging pen on the other.</li>
              <li>Tape paper down. Rough in a start Z: home, then use the printer's Move Z menu until the pen tip <i>just</i> kisses the paper. Set <b>Square 1 Z</b> a few tenths above that.</li>
              <li>Download and run the test. Squares go left → right, each one {fmt(c.step)} mm closer to the pen.</li>
              <li>Tap the <b>first</b> square that is drawn cleanly all the way round. That becomes pen-down Z.</li>
            </ol>
            <div className="grid2">
              <Num label="Square 1 Z" unit="mm" value={c.startZ} min={0} max={profile.zMax - 1} step={0.1} onChange={(startZ) => setC({ startZ })} />
              <Num label="Step per square" unit="mm" value={c.step} min={0.01} max={1} step={0.05} onChange={(step) => setC({ step })} />
              <Num label="Squares" value={c.count} min={2} max={12} step={1} decimals={0} onChange={(count) => setC({ count: Math.round(count) })} />
              <Num label="Square size" unit="mm" value={c.size} min={3} max={30} step={1} onChange={(size) => setC({ size })} />
              <Num label="Gap" unit="mm" value={c.gap} min={1} max={30} step={1} onChange={(gap) => setC({ gap })} />
              <Num label="Row Y" unit="mm" value={c.cy} min={0} max={profile.bedH} step={5} onChange={(cy) => setC({ cy })} />
            </div>
            <p className="note">Z range in this test: {fmt(c.startZ)} → {fmt(lowest)} mm. Lower Z = bed closer to the pen = more pressure. The test never goes below square {squares.length}.</p>
          </Section>
          <Section title="Tap the first clean square">
            <div className="squares">
              {squares.map((s) => (
                <button key={s.index} type="button" className={selected === s.index ? 'sq on' : 'sq'} onClick={() => onPick(s.index)}>
                  <b>{s.index}</b>
                  <span>Z {fmt(s.z)}</span>
                </button>
              ))}
            </div>
            <p className="note">
              Current pen-down Z: <b>{fmt(profile.penDownZ)}</b> · pen-up Z {fmt(profile.penUpZ)}
              {profile.penZCalibrated ? ' ✓ calibrated' : ' (not calibrated yet)'}. Picking a square keeps your lift height.
            </p>
          </Section>
        </>
      ) : (
        <>
          <Section title="Offset test">
            <ol className="steps">
              <li>Set pen-down Z first (pen-height test).</li>
              <li>Run this test: it draws a crosshair at bed centre (X {fmt(cx)}, Y {fmt(cy)}) with X/Y labels, inside a {fmt(c.squareSize)} mm square.</li>
              <li>Measure the square — it should be exactly {fmt(c.squareSize)} mm each side. If not, it's a steps/mm or belt issue, not the offset.</li>
              <li>Correct the offset with either method below.</li>
            </ol>
            <div className="grid2">
              <Num label="Square size" unit="mm" value={c.squareSize} min={10} max={150} step={5} onChange={(squareSize) => setC({ squareSize })} />
              <Num label="Cross arm" unit="mm" value={c.crossArm} min={3} max={60} step={1} onChange={(crossArm) => setC({ crossArm })} />
            </div>
            <p className="note">Current offset X {fmt(profile.penOffsetX)} Y {fmt(profile.penOffsetY)} mm → the nozzle is sent to X {fmt(cmdX)} Y {fmt(cmdY)} for the crosshair centre.</p>
          </Section>
          <Section title="Method A · Jog the nozzle over the mark (most precise)">
            <p className="note">After the test, lift the pen (raise Z a few mm), then jog X/Y from the printer menu until the <b>nozzle tip</b> is exactly over the crosshair centre. Enter the X/Y it shows.</p>
            <div className="grid2">
              <Num label="Printer shows X" unit="mm" value={readX} step={0.1} onChange={setReadX} />
              <Num label="Printer shows Y" unit="mm" value={readY} step={0.1} onChange={setReadY} />
            </div>
            <button type="button" className="btn gold wide" onClick={() => {
                const nx = profile.penOffsetX + (readX - cmdX), ny = profile.penOffsetY + (readY - cmdY);
                onSetOffset(nx, ny);
                // the readout now matches the new commanded position, so a second tap is a no-op
                setReadX(cx - nx);
                setReadY(cy - ny);
              }}>
              Set offset to X {fmt(profile.penOffsetX + (readX - cmdX))} · Y {fmt(profile.penOffsetY + (readY - cmdY))}
            </button>
          </Section>
          <Section title="Method B · Measure the miss with a ruler">
            <p className="note">Measure where the crosshair landed versus the true bed centre. Positive X = it landed to the right, positive Y = toward the back.</p>
            <div className="grid2">
              <Num label="Landed off by X" unit="mm" value={errX} step={0.5} onChange={setErrX} />
              <Num label="Landed off by Y" unit="mm" value={errY} step={0.5} onChange={setErrY} />
            </div>
            <button type="button" className="btn wide" onClick={() => { onSetOffset(profile.penOffsetX + errX, profile.penOffsetY + errY); setErrX(0); setErrY(0); }}>
              Add to offset → X {fmt(profile.penOffsetX + errX)} · Y {fmt(profile.penOffsetY + errY)}
            </button>
          </Section>
        </>
      )}
    </div>
  );
}
