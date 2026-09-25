import { Num, Section, Segmented } from '../components/Fields';
import { fmt } from '../lib/gcode';
import { DEFAULT_END_GCODE, DEFAULT_START_GCODE, ENDER5_PRO, type Profile, type ProfileStore } from '../lib/profile';
import { fmtArea, reachableArea } from '../lib/machine';

interface Props {
  store: ProfileStore;
  profile: Profile;
  update: (p: Partial<Profile>) => void;
  select: (id: string) => void;
  duplicate: () => void;
  remove: () => void;
}

const PLACEHOLDERS = '{penDownZ} {penUpZ} {safeZ} {parkZ} {parkX} {parkY} {bedX} {bedY} {drawSpeed} {travelSpeed} {zSpeed}';

export function PrinterPanel({ store, profile: p, update, select, duplicate, remove }: Props) {
  const lift = Math.round((p.penUpZ - p.penDownZ) * 1000) / 1000;
  const startWarn = !/^\s*G28\b/im.test(p.startGcode.replace(/;.*$/gm, '')) ? 'Start G-code has no G28 — the printer will not know where it is.' : null;
  return (
    <div className="panel-body">
      <Section title="Profile">
        <div className="profile-row">
          <select className="select" value={store.activeId} onChange={(e) => select(e.target.value)} aria-label="Printer profile">
            {store.profiles.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
          </select>
          <button type="button" className="btn" onClick={duplicate}>＋ Copy</button>
          <button type="button" className="btn danger" onClick={remove} disabled={store.profiles.length < 2}>Delete</button>
        </div>
        <label className="field">
          <span className="field-label">Name</span>
          <input className="num txt" value={p.name} onChange={(e) => update({ name: e.target.value })} />
        </label>
        <button
          type="button"
          className="btn small-btn"
          onClick={() => {
            if (confirm('Reset this profile to Ender-5 Pro defaults? Your pen offset and Z values will be lost.')) update({ ...ENDER5_PRO, id: p.id, name: p.name });
          }}
        >
          Reset to Ender-5 Pro defaults
        </button>
        <p className="note">Profiles are saved in this browser (localStorage). Nothing is uploaded.</p>
      </Section>

      <Section title="Pen" right={<span className={p.penZCalibrated ? 'pill ok' : 'pill bad'}>{p.penZCalibrated ? 'Z calibrated' : 'Z not calibrated'}</span>}>
        <div className="grid2">
          <Num label="Pen offset X" unit="mm" value={p.penOffsetX} step={0.5} onChange={(penOffsetX) => update({ penOffsetX })} hint="+ = pen is right of nozzle" />
          <Num label="Pen offset Y" unit="mm" value={p.penOffsetY} step={0.5} onChange={(penOffsetY) => update({ penOffsetY })} hint="+ = pen is behind nozzle" />
          <Num label="Pen-down Z" unit="mm" value={p.penDownZ} min={0} max={p.zMax - 1} step={0.05} onChange={(v) => update({ penDownZ: v, penUpZ: v + lift, penZCalibrated: true })} hint="Pen touches paper. Lowest Z ever sent." />
          <Num label="Pen lift" unit="mm" value={lift} min={0.2} max={30} step={0.5} onChange={(l) => update({ penUpZ: p.penDownZ + l })} hint={`Pen-up Z = ${fmt(p.penUpZ)}`} />
          <Num label="Safe travel Z" unit="mm" value={p.safeZ} min={0} max={p.zMax} step={1} onChange={(safeZ) => update({ safeZ })} hint="First move after homing" />
        </div>
        <p className="note">Ender-5: Z homes with the bed at the top; bigger Z moves the bed down, away from the pen. Reachable pen area: {fmtArea(reachableArea(p))}.</p>
      </Section>

      <Section title="Speeds & dwell">
        <div className="grid2">
          <Num label="Draw speed" unit="mm/min" value={p.drawSpeed} min={30} max={p.maxXYSpeed} step={100} decimals={0} onChange={(drawSpeed) => update({ drawSpeed })} />
          <Num label="Travel speed" unit="mm/min" value={p.travelSpeed} min={30} max={p.maxXYSpeed} step={100} decimals={0} onChange={(travelSpeed) => update({ travelSpeed })} />
          <Num label="Z speed" unit="mm/min" value={p.zSpeed} min={30} max={p.maxZSpeed} step={30} decimals={0} onChange={(zSpeed) => update({ zSpeed })} />
          <Num label="Dwell after pen down" unit="ms" value={p.dwellDownMs} min={0} max={10000} step={10} decimals={0} onChange={(dwellDownMs) => update({ dwellDownMs })} />
          <Num label="Dwell after pen up" unit="ms" value={p.dwellUpMs} min={0} max={10000} step={10} decimals={0} onChange={(dwellUpMs) => update({ dwellUpMs })} />
        </div>
      </Section>

      <Section title="Sharp corners">
        <Segmented
          label="Corner handling"
          value={p.cornerMode}
          onChange={(cornerMode) => update({ cornerMode })}
          options={[{ value: 'off', label: 'Off' }, { value: 'dwell', label: 'Dwell' }, { value: 'slow', label: 'Slow down' }]}
        />
        {p.cornerMode !== 'off' && (
          <div className="grid2">
            <Num label="Corner angle over" unit="°" value={p.cornerAngle} min={5} max={179} step={5} decimals={0} onChange={(cornerAngle) => update({ cornerAngle })} />
            {p.cornerMode === 'dwell' ? (
              <Num label="Corner dwell" unit="ms" value={p.cornerDwellMs} min={0} max={5000} step={10} decimals={0} onChange={(cornerDwellMs) => update({ cornerDwellMs })} />
            ) : (
              <>
                <Num label="Corner speed" unit="%" value={p.cornerSlowPct} min={5} max={100} step={5} decimals={0} onChange={(cornerSlowPct) => update({ cornerSlowPct })} />
                <Num label="Slow zone" unit="mm" value={p.cornerSlowLen} min={0.1} max={50} step={0.5} onChange={(cornerSlowLen) => update({ cornerSlowLen })} />
              </>
            )}
          </div>
        )}
        <p className="note">For a pen that lags behind the head: pause, or slow down near turns sharper than the angle.</p>
      </Section>

      <Section title="Machine">
        <div className="grid2">
          <Num label="Bed width (X)" unit="mm" value={p.bedW} min={10} max={2000} step={10} onChange={(bedW) => update({ bedW })} />
          <Num label="Bed depth (Y)" unit="mm" value={p.bedH} min={10} max={2000} step={10} onChange={(bedH) => update({ bedH })} />
          <Num label="Nozzle X min" unit="mm" value={p.xMin} step={1} onChange={(xMin) => update({ xMin })} />
          <Num label="Nozzle X max" unit="mm" value={p.xMax} step={1} onChange={(xMax) => update({ xMax })} />
          <Num label="Nozzle Y min" unit="mm" value={p.yMin} step={1} onChange={(yMin) => update({ yMin })} />
          <Num label="Nozzle Y max" unit="mm" value={p.yMax} step={1} onChange={(yMax) => update({ yMax })} />
          <Num label="Z max" unit="mm" value={p.zMax} min={5} max={2000} step={10} onChange={(zMax) => update({ zMax })} />
          <Num label="Max XY speed" unit="mm/min" value={p.maxXYSpeed} min={60} max={60000} step={500} decimals={0} onChange={(maxXYSpeed) => update({ maxXYSpeed })} />
          <Num label="Max Z speed" unit="mm/min" value={p.maxZSpeed} min={30} max={6000} step={30} decimals={0} onChange={(maxZSpeed) => update({ maxZSpeed })} />
          <Num label="Home X (after G28)" unit="mm" value={p.homeX} step={1} onChange={(homeX) => update({ homeX })} />
          <Num label="Home Y (after G28)" unit="mm" value={p.homeY} step={1} onChange={(homeY) => update({ homeY })} />
        </div>
      </Section>

      <Section title="Start G-code" right={<button type="button" className="link-btn" onClick={() => update({ startGcode: DEFAULT_START_GCODE })}>Restore default</button>}>
        <textarea className="code" rows={8} value={p.startGcode} onChange={(e) => update({ startGcode: e.target.value })} spellCheck={false} aria-label="Start G-code" />
        {startWarn && <p className="warn">{startWarn}</p>}
      </Section>
      <Section title="End G-code" right={<button type="button" className="link-btn" onClick={() => update({ endGcode: DEFAULT_END_GCODE })}>Restore default</button>}>
        <textarea className="code" rows={5} value={p.endGcode} onChange={(e) => update({ endGcode: e.target.value })} spellCheck={false} aria-label="End G-code" />
        <p className="note">
          Placeholders: <code>{PLACEHOLDERS}</code>. Pen Plot always adds a lift to safe Z right after your start G-code, comments out any heating or extrusion, and raises any Z below pen-down Z.
        </p>
      </Section>
    </div>
  );
}
