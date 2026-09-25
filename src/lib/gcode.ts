/**
 * Pen-plotter G-code generation. Never slices, never extrudes, never heats.
 * Every path: pen up -> dwell -> travel -> pen down -> dwell -> draw.
 */
import { type Polyline, type Pt, dist } from './geometry';
import { clipPolylines } from './clip';
import { clampToArea, inArea, penToNozzle, reachableArea } from './machine';
import type { Profile } from './profile';

export interface PlotPath {
  /** Pen-tip coordinates on the bed (mm, origin front-left, +Y toward the back) */
  pts: Polyline;
  /** Optional per-path pen-down Z (calibration squares). Never lower than the floor. */
  z?: number;
}

export interface GcodeOptions {
  title?: string;
  /** Extra comment lines for the header (e.g. calibration square Z values) */
  notes?: string[];
  /** 'clip' drops parts outside the reachable area; 'clamp' pushes points onto its edge */
  boundsMode?: 'clip' | 'clamp';
  /** Lowest Z this file may use. Defaults to the profile's pen-down Z. */
  minZ?: number;
  /** Fixed timestamp for reproducible output (tests) */
  date?: Date;
}

export interface GcodeResult {
  gcode: string;
  lineCount: number;
  estSeconds: number;
  drawMm: number;
  travelMm: number;
  penLifts: number;
  paths: number;
  outsidePoints: number;
  warnings: string[];
  minZ: number;
}

export function fmt(n: number): string {
  const s = (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m ${r}s` : m ? `${m}m ${r}s` : `${r}s`;
}

/** Values usable as {placeholders} in the start/end G-code. */
export function templateVars(p: Profile): Record<string, string> {
  return {
    penDownZ: fmt(p.penDownZ),
    penUpZ: fmt(p.penUpZ),
    safeZ: fmt(p.safeZ),
    parkZ: fmt(Math.min(p.zMax, Math.max(p.safeZ, p.penUpZ + 20))),
    parkX: fmt(p.xMin),
    parkY: fmt(p.yMax),
    bedX: fmt(p.bedW),
    bedY: fmt(p.bedH),
    drawSpeed: fmt(p.drawSpeed),
    travelSpeed: fmt(p.travelSpeed),
    zSpeed: fmt(p.zSpeed),
  };
}

export function applyTemplate(src: string, vars: Record<string, string>): string {
  return src.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/**
 * Make user-supplied start/end G-code safe for a pen: comment out extrusion and heating,
 * and raise any explicit Z below the floor.
 */
export function sanitizeUserGcode(src: string, floorZ: number, warnings: string[], label: string): string[] {
  const out: string[] = [];
  for (const rawLine of src.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trimEnd();
    const code = line.replace(/;.*$/, '').trim().toUpperCase();
    if (!code) { if (line.trim()) out.push(line.trim()); continue; }
    const word = code.split(/\s+/)[0];
    const sParam = /\bS\s*(-?[\d.]+)/.exec(code);
    const heat = /^M(104|109|140|190|141|191)$/.test(word) && (!sParam || parseFloat(sParam[1]) !== 0 || word === 'M109' || word === 'M190' || word === 'M191');
    const extrude = /^G0?[0-3]$/.test(word) && /\bE\s*[-+.\d]/.test(code);
    const extruderCmd = /^(M101|M103|G10|G11|M83|M82)$/.test(word) || /^G92$/.test(word) && /\bE/.test(code);
    if (heat || extrude || extruderCmd) {
      out.push(`; [removed by Pen Plot: no heat / no extrusion] ${line.trim()}`);
      warnings.push(`${label}: removed "${line.trim()}" (pen plotting never heats or extrudes).`);
      continue;
    }
    if (/^G0?[0-3]$/.test(word)) {
      const zm = /\bZ\s*(-?[\d.]+)/i.exec(line);
      if (zm && parseFloat(zm[1]) < floorZ - 1e-9) {
        warnings.push(`${label}: raised Z${zm[1]} to pen-down Z ${fmt(floorZ)}.`);
        out.push(line.replace(/\bZ\s*-?[\d.]+/i, `Z${fmt(floorZ)}`) + ' ; Z raised to pen-down floor');
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

function cornerFlags(p: Polyline, angleDeg: number): boolean[] {
  const flags = new Array<boolean>(p.length).fill(false);
  const cosLim = Math.cos((angleDeg * Math.PI) / 180);
  for (let i = 1; i < p.length - 1; i++) {
    const ax = p[i].x - p[i - 1].x, ay = p[i].y - p[i - 1].y;
    const bx = p[i + 1].x - p[i].x, by = p[i + 1].y - p[i].y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const c = (ax * bx + ay * by) / (la * lb);
    flags[i] = c < cosLim; // direction change bigger than the threshold
  }
  return flags;
}

export function generateGcode(input: PlotPath[], prof: Profile, opts: GcodeOptions = {}): GcodeResult {
  const warnings: string[] = [];
  const floorZ = Math.max(0, opts.minZ ?? prof.penDownZ);
  const lift = Math.max(0.2, prof.penUpZ - prof.penDownZ);
  const area = reachableArea(prof);
  const mode = opts.boundsMode ?? 'clip';
  const vars = templateVars(prof);

  // ---- bounds handling (pen coordinates) ----
  let outsidePoints = 0;
  const paths: { pts: Polyline; zDown: number; zUp: number }[] = [];
  for (const pp of input) {
    for (const q of pp.pts) if (!inArea(q, area)) outsidePoints++;
    const pieces = mode === 'clip' ? clipPolylines([pp.pts], area) : [pp.pts.map((q) => clampToArea(q, area))];
    const zDown = Math.min(prof.zMax, Math.max(floorZ, pp.z ?? prof.penDownZ));
    const zUp = Math.min(prof.zMax, Math.max(prof.penUpZ, zDown + lift));
    for (const pts of pieces) if (pts.length >= 2) paths.push({ pts, zDown, zUp });
  }
  if (outsidePoints) {
    warnings.push(
      mode === 'clip'
        ? `${outsidePoints} point(s) were outside the reachable area; those parts were clipped (not drawn).`
        : `${outsidePoints} point(s) were outside the reachable area and were clamped to its edge.`,
    );
  }

  const body: string[] = [];
  let t = 0; // seconds
  let drawMm = 0, travelMm = 0, penLifts = 0;
  let feed = -1;
  let pos: Pt = { x: prof.homeX, y: prof.homeY }; // nozzle
  let z = 0; // after G28 the bed is at the top (Z0)
  let minZ = Infinity;

  const setZ = (nz: number, cmd: 'G0' | 'G1', comment: string) => {
    const zz = Math.max(nz, floorZ);
    minZ = Math.min(minZ, zz);
    body.push(`${cmd} Z${fmt(zz)} F${fmt(prof.zSpeed)} ; ${comment}`);
    feed = prof.zSpeed;
    t += (Math.abs(zz - z) / prof.zSpeed) * 60;
    z = zz;
  };
  const dwell = (ms: number, comment: string) => {
    body.push(`G4 P${Math.max(0, Math.round(ms))} ; ${comment}`);
    t += ms / 1000;
  };
  const move = (cmd: 'G0' | 'G1', target: Pt, f: number) => {
    const n = penToNozzle(target, prof);
    // final safety net: never command outside the machine limits
    n.x = Math.min(prof.xMax, Math.max(prof.xMin, n.x));
    n.y = Math.min(prof.yMax, Math.max(prof.yMin, n.y));
    const d = dist(pos, n);
    if (d < 1e-6) return;
    body.push(`${cmd} X${fmt(n.x)} Y${fmt(n.y)}${f !== feed ? ` F${fmt(f)}` : ''}`);
    feed = f;
    t += (d / f) * 60;
    if (cmd === 'G0') travelMm += d; else drawMm += d;
    pos = n;
  };

  // ---- start ----
  const start = sanitizeUserGcode(applyTemplate(prof.startGcode, vars), floorZ, warnings, 'Start G-code');
  t += 20; // homing, roughly
  // Always lift to safe Z right after the start block, before the first XY move.
  const safe = Math.max(prof.safeZ, prof.penUpZ);
  body.push('; ---- first move after homing: lift to safe Z ----');
  setZ(safe, 'G0', 'safe travel Z');

  const slowF = Math.max(30, (prof.drawSpeed * prof.cornerSlowPct) / 100);
  paths.forEach((pp, idx) => {
    const p = pp.pts;
    body.push(`; path ${idx + 1}/${paths.length}${pp.zDown !== prof.penDownZ ? ` (pen-down Z ${fmt(pp.zDown)})` : ''}`);
    if (idx > 0 || z < pp.zUp) {
      setZ(Math.max(pp.zUp, idx > 0 ? z + lift : z), 'G0', 'pen up');
      dwell(prof.dwellUpMs, 'settle after pen up');
      if (idx > 0) penLifts++;
    }
    move('G0', p[0], prof.travelSpeed);
    setZ(pp.zDown, 'G1', 'pen down');
    dwell(prof.dwellDownMs, 'settle after pen down');
    const corners = prof.cornerMode !== 'off' ? cornerFlags(p, prof.cornerAngle) : null;
    for (let i = 1; i < p.length; i++) {
      if (prof.cornerMode === 'slow' && corners && (corners[i - 1] || corners[i])) {
        const a = p[i - 1], b = p[i];
        const L = dist(a, b);
        const s0 = corners[i - 1] ? Math.min(prof.cornerSlowLen, L / 2) : 0;
        const s1 = corners[i] ? Math.min(prof.cornerSlowLen, L / 2) : 0;
        const lerp = (tt: number): Pt => ({ x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt });
        if (s0 > 0) move('G1', lerp(s0 / L), slowF);
        if (L - s0 - s1 > 1e-6) move('G1', lerp((L - s1) / L), prof.drawSpeed);
        move('G1', b, s1 > 0 ? slowF : prof.drawSpeed);
      } else {
        move('G1', p[i], prof.drawSpeed);
      }
      if (prof.cornerMode === 'dwell' && corners && corners[i]) dwell(prof.cornerDwellMs, 'corner');
    }
  });

  // ---- end ----
  body.push('; ---- finished: pen up ----');
  setZ(Math.max(prof.penUpZ, z), 'G0', 'pen up');
  dwell(prof.dwellUpMs, 'settle after pen up');
  const end = sanitizeUserGcode(applyTemplate(prof.endGcode, vars), floorZ, warnings, 'End G-code');
  if (minZ === Infinity) minZ = floorZ;

  const header = [
    '; ==========================================================',
    '; Pen Plot — pen-plotter G-code (no slicing, no extrusion, no heat)',
    '; https://penplot.gearup.wtf',
    `; Title: ${(opts.title ?? 'Untitled').replace(/[\r\n]+/g, ' ')}`,
    `; Generated: ${(opts.date ?? new Date()).toISOString()}`,
    `; Printer: ${prof.name} — bed ${fmt(prof.bedW)} x ${fmt(prof.bedH)} mm, nozzle X ${fmt(prof.xMin)}..${fmt(prof.xMax)} Y ${fmt(prof.yMin)}..${fmt(prof.yMax)}`,
    `; Pen offset from nozzle: X ${fmt(prof.penOffsetX)} Y ${fmt(prof.penOffsetY)} mm (coordinates below are NOZZLE positions)`,
    `; Pen-down Z ${fmt(prof.penDownZ)}${prof.penZCalibrated ? '' : ' (NOT CALIBRATED — run the pen-height test)'} | pen-up Z ${fmt(prof.penUpZ)} | safe Z ${fmt(prof.safeZ)} | lowest Z in file ${fmt(minZ)}`,
    `; Speeds (mm/min): draw ${fmt(prof.drawSpeed)}, travel ${fmt(prof.travelSpeed)}, Z ${fmt(prof.zSpeed)}`,
    `; Dwell: ${prof.dwellDownMs} ms after pen down, ${prof.dwellUpMs} ms after pen up`,
    `; Corners: ${prof.cornerMode === 'off' ? 'no special handling' : prof.cornerMode === 'dwell' ? `dwell ${prof.cornerDwellMs} ms at turns > ${fmt(prof.cornerAngle)}°` : `slow to ${fmt(prof.cornerSlowPct)}% for ${fmt(prof.cornerSlowLen)} mm around turns > ${fmt(prof.cornerAngle)}°`}`,
    `; Bounds: reachable pen area X ${fmt(area.minX)}..${fmt(area.maxX)} Y ${fmt(area.minY)}..${fmt(area.maxY)} (${mode})`,
    `; Paths: ${paths.length} | pen lifts: ${penLifts} | draw ${fmt(Math.round(drawMm))} mm | travel ${fmt(Math.round(travelMm))} mm`,
    `; Estimated time: ${fmtDuration(t)} (approx., ignores acceleration)`,
    '; Lines: __LINES__',
    ...(opts.notes ?? []).map((n) => `; ${n}`),
    ...warnings.map((w) => `; WARNING: ${w}`),
    '; ==========================================================',
  ];
  const all = [...header, '; ---- start G-code ----', ...start, ...body, '; ---- end G-code ----', ...end];
  const lineCount = all.length;
  all[header.indexOf('; Lines: __LINES__')] = `; Lines: ${lineCount}`;
  return {
    gcode: all.join('\n') + '\n',
    lineCount,
    estSeconds: t,
    drawMm,
    travelMm,
    penLifts,
    paths: paths.length,
    outsidePoints,
    warnings,
    minZ,
  };
}
