/** Printer profiles: machine limits, pen geometry, speeds and start/end G-code. */

export type CornerMode = 'off' | 'dwell' | 'slow';

export interface Profile {
  id: string;
  name: string;
  /** Printable bed size (mm) — the paper lives here */
  bedW: number;
  bedH: number;
  /** Nozzle travel limits (mm). Pen tip = nozzle + offset. */
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMax: number;
  /** Where the nozzle sits after G28 (used as the start point for travel optimisation) */
  homeX: number;
  homeY: number;
  /** Pen tip position relative to the nozzle (mm). +X = right, +Y = toward the back. */
  penOffsetX: number;
  penOffsetY: number;
  /** Z where the pen touches the paper. On an Ender-5, larger Z = bed further away. */
  penDownZ: number;
  /** Set once pen-down Z has been confirmed with the calibration squares (or typed in by hand) */
  penZCalibrated: boolean;
  /** Z during travel moves (pen lifted) */
  penUpZ: number;
  /** Z for the first move after homing */
  safeZ: number;
  /** mm/min */
  drawSpeed: number;
  travelSpeed: number;
  zSpeed: number;
  maxXYSpeed: number;
  maxZSpeed: number;
  /** G4 P<ms> after lowering / lifting the pen */
  dwellDownMs: number;
  dwellUpMs: number;
  cornerMode: CornerMode;
  /** Direction change (degrees) that counts as a sharp corner */
  cornerAngle: number;
  cornerDwellMs: number;
  /** Slow-down mode: percent of draw speed and distance either side of the corner (mm) */
  cornerSlowPct: number;
  cornerSlowLen: number;
  startGcode: string;
  endGcode: string;
}

export const DEFAULT_START_GCODE = `G21 ; millimetres
G90 ; absolute positioning
M104 S0 ; hotend heater OFF (pen plotting, no heat)
M140 S0 ; bed heater OFF
M107 ; part fan off
G28 ; home all axes (Ender-5: Z homes with the bed at the top)
G0 Z{safeZ} F{zSpeed} ; drop the bed to safe travel Z before any XY move`;

export const DEFAULT_END_GCODE = `G0 Z{penUpZ} F{zSpeed} ; make sure the pen is lifted
G0 Z{parkZ} F{zSpeed} ; lower the bed away from the pen
G0 X{parkX} Y{parkY} F{travelSpeed} ; move the head out of the way
M84 ; motors off`;

export const ENDER5_PRO: Profile = {
  id: 'ender5pro',
  name: 'Creality Ender-5 Pro',
  bedW: 220,
  bedH: 220,
  xMin: 0,
  xMax: 220,
  yMin: 0,
  yMax: 220,
  zMax: 300,
  homeX: 220,
  homeY: 220,
  penOffsetX: 0,
  penOffsetY: 0,
  penDownZ: 5,
  penZCalibrated: false,
  penUpZ: 8,
  safeZ: 15,
  drawSpeed: 1500,
  travelSpeed: 4800,
  zSpeed: 300,
  maxXYSpeed: 9000,
  maxZSpeed: 600,
  dwellDownMs: 150,
  dwellUpMs: 80,
  cornerMode: 'off',
  cornerAngle: 60,
  cornerDwellMs: 60,
  cornerSlowPct: 40,
  cornerSlowLen: 1.5,
  startGcode: DEFAULT_START_GCODE,
  endGcode: DEFAULT_END_GCODE,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Fill in missing fields and enforce the safety relationships between values. */
export function normalizeProfile(p: Partial<Profile>): Profile {
  const d = ENDER5_PRO;
  const out: Profile = { ...d, ...p } as Profile;
  for (const k of Object.keys(d) as (keyof Profile)[]) {
    if (typeof d[k] === 'number') (out as unknown as Record<string, number>)[k] = fin(out[k], d[k] as number);
  }
  out.bedW = clamp(out.bedW, 10, 2000);
  out.bedH = clamp(out.bedH, 10, 2000);
  if (out.xMax <= out.xMin) out.xMax = out.xMin + out.bedW;
  if (out.yMax <= out.yMin) out.yMax = out.yMin + out.bedH;
  out.zMax = clamp(out.zMax, 5, 2000);
  out.maxXYSpeed = clamp(out.maxXYSpeed, 60, 60000);
  out.maxZSpeed = clamp(out.maxZSpeed, 30, 6000);
  out.drawSpeed = clamp(out.drawSpeed, 30, out.maxXYSpeed);
  out.travelSpeed = clamp(out.travelSpeed, 30, out.maxXYSpeed);
  out.zSpeed = clamp(out.zSpeed, 30, out.maxZSpeed);
  out.penDownZ = clamp(out.penDownZ, 0, out.zMax - 1);
  out.penUpZ = clamp(Math.max(out.penUpZ, out.penDownZ + 0.2), 0, out.zMax);
  out.safeZ = clamp(Math.max(out.safeZ, out.penUpZ), 0, out.zMax);
  out.dwellDownMs = clamp(Math.round(out.dwellDownMs), 0, 10000);
  out.dwellUpMs = clamp(Math.round(out.dwellUpMs), 0, 10000);
  out.cornerDwellMs = clamp(Math.round(out.cornerDwellMs), 0, 5000);
  out.cornerAngle = clamp(out.cornerAngle, 5, 179);
  out.cornerSlowPct = clamp(out.cornerSlowPct, 5, 100);
  out.cornerSlowLen = clamp(out.cornerSlowLen, 0.1, 50);
  if (!['off', 'dwell', 'slow'].includes(out.cornerMode)) out.cornerMode = 'off';
  out.penZCalibrated = out.penZCalibrated === true;
  if (typeof out.startGcode !== 'string') out.startGcode = d.startGcode;
  if (typeof out.endGcode !== 'string') out.endGcode = d.endGcode;
  if (typeof out.name !== 'string' || !out.name.trim()) out.name = 'Custom printer';
  if (typeof out.id !== 'string' || !out.id) out.id = `custom-${Date.now().toString(36)}`;
  return out;
}

// ------------------------------------------------------------ storage ------
const KEY = 'penplot.profiles.v1';
const ACTIVE_KEY = 'penplot.activeProfile.v1';

export interface ProfileStore {
  profiles: Profile[];
  activeId: string;
}

export function loadProfiles(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ProfileStore {
  let profiles: Profile[] = [];
  try {
    const raw = storage?.getItem(KEY);
    if (raw) profiles = (JSON.parse(raw) as Partial<Profile>[]).map(normalizeProfile);
  } catch {
    profiles = [];
  }
  if (!profiles.length) profiles = [{ ...ENDER5_PRO }];
  const activeId = storage?.getItem(ACTIVE_KEY) ?? profiles[0].id;
  return { profiles, activeId: profiles.some((p) => p.id === activeId) ? activeId : profiles[0].id };
}

export function saveProfiles(store: ProfileStore, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(store.profiles));
    storage?.setItem(ACTIVE_KEY, store.activeId);
  } catch {
    /* storage full or blocked: settings just won't persist */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
