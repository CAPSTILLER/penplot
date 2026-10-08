/**
 * Layer-Zero Slab Simulator: a fixed base-blue laser shines straight down through an optic
 * onto a stone slab that moves under it. Exposure accumulates on a grid in slab coordinates.
 *
 * Slab coordinates: mm, origin at the slab centre, +X right, +Y up (toward the slab's top edge).
 * Slab pose: translation (tx, ty) of its centre in mm and rotation `rot` in degrees, clockwise positive.
 */
import { type Polyline, type Pt, simplify } from './geometry';
import { clipPolylines } from './clip';

export const SLAB_W = 150;
export const SLAB_H = 68;
export const SLAB_T = 6;
export const PX_PER_MM = 10;
export const GW = SLAB_W * PX_PER_MM;
export const GH = SLAB_H * PX_PER_MM;
/** Seconds of exposure that give a full, bright, deep dot. */
export const FULL_EXPOSURE_S = 125;
/** Diffraction cube reference: 50 mm above the slab gives 18.8 mm between spots. */
export const CUBE_ZERO_MM = 50;
export const CUBE_ZERO_SPACING = 18.8;
export const CUBE_SPOTS = 7;

export type StepAction = 'up' | 'down' | 'left' | 'right' | 'cw' | 'ccw' | 'dwell' | 'circle' | 'spiral';
export interface Step {
  id: string;
  action: StepAction;
  /** mm for moves, degrees for rotations, diameter (mm) for circle, ignored for dwell */
  amount: number;
  /** seconds per repeat (before the time multiplier) */
  duration: number;
  repeat: number;
  /** spot traces rings of this diameter (mm) during the step (moves / rotations / dwell); 0 = off */
  ring?: number;
  /** seconds per ring revolution (default 3) */
  ringRev?: number;
  /** spiral turns (spiral action, default 3) */
  turns?: number;
}
export type OpticKind = 'none' | 'prism' | 'cube';
export interface Optics {
  kind: OpticKind;
  /** mm from the reference (zero) position; negative = closer to the slab */
  distance: number;
  /** prism bend angle, degrees */
  prismAngle: number;
}
export interface RunSpec {
  name: string;
  steps: Step[];
  optics: Optics;
  /** 2 = every step takes twice as long (double exposure, same distances) */
  multiplier: number;
  /** spot traces a circle of this diameter continuously during the whole run (0 = off) */
  circleDia: number;
  /** seconds per circle revolution (not scaled by the multiplier) */
  circleRev: number;
  /** laser spot diameter on the slab, mm */
  spotDia: number;
  /** laser on at the home position for this many seconds before step 1 (burns the start dots) */
  homeDwell?: number;
}

export const ACTIONS: { value: StepAction; label: string; unit: string }[] = [
  { value: 'up', label: 'Move up', unit: 'mm' },
  { value: 'down', label: 'Move down', unit: 'mm' },
  { value: 'left', label: 'Move left', unit: 'mm' },
  { value: 'right', label: 'Move right', unit: 'mm' },
  { value: 'cw', label: 'Rotate CW', unit: '°' },
  { value: 'ccw', label: 'Rotate CCW', unit: '°' },
  { value: 'dwell', label: 'Dwell', unit: '' },
  { value: 'circle', label: 'Circle (dia)', unit: 'mm' },
  { value: 'spiral', label: 'Spiral (dia)', unit: 'mm' },
];

let idn = 0;
export const stepId = () => `s${Date.now().toString(36)}${(idn++).toString(36)}`;
export const mkStep = (action: StepAction, amount: number, duration: number, repeat = 1): Step => ({ id: stepId(), action, amount, duration, repeat });

/** Cap Sequence 1, straight from the brief. "1 mm per second for 30 s" = 1 mm in 1 s, repeated 30 times. */
export function capSequence1(): Step[] {
  return [
    mkStep('up', 1, 1, 30),
    mkStep('down', 31, 1, 1),
    mkStep('down', 1, 1, 29),
    mkStep('up', 30, 1, 1),
    mkStep('cw', 1, 1, 30),
    mkStep('ccw', 31, 1, 1),
    mkStep('ccw', 1, 1, 30),
  ];
}
export const PRESETS: Record<string, () => Step[]> = { 'Cap Sequence 1': capSequence1 };

export const DEFAULT_OPTICS: Optics = { kind: 'cube', distance: 0, prismAngle: 15 };

export function cubeSpacing(distance: number): number {
  return (CUBE_ZERO_SPACING * Math.max(1, CUBE_ZERO_MM + distance)) / CUBE_ZERO_MM;
}
export function prismOffset(o: Optics): number {
  return Math.max(1, CUBE_ZERO_MM + o.distance) * Math.tan((o.prismAngle * Math.PI) / 180);
}

/** Beam spot positions (world mm, relative to the slab centre's home position). */
export function spotPositions(o: Optics): Pt[] {
  if (o.kind === 'cube') {
    const s = cubeSpacing(o.distance);
    return Array.from({ length: CUBE_SPOTS }, (_, i) => ({ x: (i - (CUBE_SPOTS - 1) / 2) * s, y: 0 }));
  }
  if (o.kind === 'prism') return [{ x: prismOffset(o), y: 0 }];
  return [{ x: 0, y: 0 }];
}

export function runDuration(r: RunSpec): number {
  return r.steps.reduce((a, s) => a + Math.max(0, s.duration) * Math.max(0, Math.round(s.repeat)) * r.multiplier, Math.max(0, r.homeDwell ?? 0) * r.multiplier);
}

// ------------------------------------------------------------------ sampling

interface Pose { tx: number; ty: number; rot: number }
export interface Samples {
  n: number;
  spots: number;
  /** end time of each sample */
  tEnd: Float64Array;
  dt: Float32Array;
  /** slab pose per sample (for the live view) */
  tx: Float32Array;
  ty: Float32Array;
  rot: Float32Array;
  /** beam offset from its nominal position (circle tracing), world mm */
  bx: Float32Array;
  by: Float32Array;
  /** which step (index in run.steps) each sample belongs to */
  step: Int32Array;
  /** spot positions on the slab, [k * spots + i] */
  xs: Float32Array;
  ys: Float32Array;
  total: number;
}

const MAX_SAMPLES = 220_000;

export function sampleRun(run: RunSpec, maxStepMm = 0.08): Samples {
  const spots = spotPositions(run.optics);
  const maxSpotR = Math.max(...spots.map((p) => Math.hypot(p.x, p.y)));
  const mult = Math.max(0.01, run.multiplier || 1);
  const gR = Math.max(0, run.circleDia) / 2;
  const rev = Math.max(0.05, run.circleRev || 1);
  // expand steps into segments
  const segs: { from: Pose; to: Pose; dur: number; t0: number; stepCircle: number; step: number; ringR?: number; ringRev?: number; spiralR?: number; turns?: number }[] = [];
  let pose: Pose = { tx: 0, ty: 0, rot: 0 };
  let t = 0;
  const hd = Math.max(0, run.homeDwell ?? 0) * mult;
  if (hd > 0) { segs.push({ from: pose, to: pose, dur: hd, t0: 0, stepCircle: 0, step: -1 }); t = hd; }
  run.steps.forEach((s, si) => {
    const reps = Math.max(0, Math.min(10000, Math.round(s.repeat)));
    for (let r = 0; r < reps; r++) {
      const to = { ...pose };
      const a = s.amount;
      if (s.action === 'up') to.ty += a;
      else if (s.action === 'down') to.ty -= a;
      else if (s.action === 'left') to.tx -= a;
      else if (s.action === 'right') to.tx += a;
      else if (s.action === 'cw') to.rot += a;
      else if (s.action === 'ccw') to.rot -= a;
      const dur = Math.max(0, s.duration) * mult;
      segs.push({
        from: pose, to, dur, t0: t, stepCircle: s.action === 'circle' ? Math.max(0, a) / 2 : 0, step: si,
        ringR: s.action !== 'circle' && s.action !== 'spiral' ? Math.max(0, s.ring ?? 0) / 2 : 0, ringRev: Math.max(0.2, s.ringRev ?? 3),
        spiralR: s.action === 'spiral' ? Math.max(0, a) / 2 : 0, turns: Math.max(0.5, s.turns ?? 3),
      });
      pose = to;
      t += dur;
    }
  });
  const counts = segs.map((g) => {
    if (g.dur <= 0) return 0;
    const extra = (g.ringR ?? 0) + (g.spiralR ?? 0);
    const lever = maxSpotR + gR + g.stepCircle + extra + Math.max(Math.hypot(g.from.tx, g.from.ty), Math.hypot(g.to.tx, g.to.ty));
    const L = Math.hypot(g.to.tx - g.from.tx, g.to.ty - g.from.ty) + (Math.abs(g.to.rot - g.from.rot) * Math.PI / 180) * lever
      + (gR > 0 ? (2 * Math.PI * gR * g.dur) / rev : 0) + 2 * Math.PI * g.stepCircle
      + (g.ringR ? (2 * Math.PI * g.ringR * g.dur) / (g.ringRev ?? 3) : 0) + (g.spiralR ? Math.PI * g.spiralR * (g.turns ?? 3) : 0);
    return Math.max(1, Math.ceil(L / maxStepMm));
  });
  let n = counts.reduce((a, b) => a + b, 0);
  if (n > MAX_SAMPLES) {
    const k = MAX_SAMPLES / n;
    for (let i = 0; i < counts.length; i++) if (counts[i]) counts[i] = Math.max(1, Math.floor(counts[i] * k));
    n = counts.reduce((a, b) => a + b, 0);
  }
  const ns = spots.length;
  const out: Samples = {
    n, spots: ns, total: t,
    tEnd: new Float64Array(n), dt: new Float32Array(n), tx: new Float32Array(n), ty: new Float32Array(n), rot: new Float32Array(n),
    bx: new Float32Array(n), by: new Float32Array(n), step: new Int32Array(n), xs: new Float32Array(n * ns), ys: new Float32Array(n * ns),
  };
  let k = 0;
  segs.forEach((g, gi) => {
    const c = counts[gi];
    for (let j = 0; j < c; j++) {
      const u = (j + 0.5) / c; // midpoint sample
      const time = g.t0 + u * g.dur;
      const tx = g.from.tx + (g.to.tx - g.from.tx) * u;
      const ty = g.from.ty + (g.to.ty - g.from.ty) * u;
      const rot = g.from.rot + (g.to.rot - g.from.rot) * u;
      let bx = 0, by = 0;
      if (gR > 0) { const ph = (2 * Math.PI * time) / rev; bx += gR * Math.cos(ph); by += gR * Math.sin(ph); }
      if (g.stepCircle > 0) { const ph = 2 * Math.PI * u; bx += g.stepCircle * Math.cos(ph); by += g.stepCircle * Math.sin(ph); }
      if (g.ringR) { const ph = (2 * Math.PI * (u * g.dur)) / (g.ringRev ?? 3); bx += g.ringR * Math.cos(ph); by += g.ringR * Math.sin(ph); }
      if (g.spiralR) { const ph = 2 * Math.PI * (g.turns ?? 3) * u; bx += g.spiralR * u * Math.cos(ph); by += g.spiralR * u * Math.sin(ph); }
      out.tEnd[k] = g.t0 + ((j + 1) / c) * g.dur;
      out.dt[k] = g.dur / c;
      out.tx[k] = tx; out.ty[k] = ty; out.rot[k] = rot; out.bx[k] = bx; out.by[k] = by; out.step[k] = g.step;
      const r = (rot * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
      for (let i = 0; i < ns; i++) {
        const dx = spots[i].x + bx - tx, dy = spots[i].y + by - ty;
        // world = Rcw(rot)·slab + t  =>  slab = Rccw(rot)·(world - t)
        out.xs[k * ns + i] = cs * dx - sn * dy;
        out.ys[k * ns + i] = sn * dx + cs * dy;
      }
      k++;
    }
  });
  return out;
}

// ------------------------------------------------------------------ exposure grid

export interface FaceGrid {
  /** exposure seconds per cell (GW x GH, row 0 = top edge of the slab) */
  e: Float32Array;
  /** number of separate passes over each cell */
  passes: Uint16Array;
  seconds: number;
  runs: number;
}
export const newGrid = (): FaceGrid => ({ e: new Float32Array(GW * GH), passes: new Uint16Array(GW * GH), seconds: 0, runs: 0 });
export const cloneGrid = (g: FaceGrid): FaceGrid => ({ e: g.e.slice(), passes: g.passes.slice(), seconds: g.seconds, runs: g.runs });

export function kernel(spotDia: number): { off: Int32Array; dx: Int8Array; dy: Int8Array; w: Float32Array } {
  const R = (Math.max(0.3, spotDia) / 2) * PX_PER_MM;
  const r = Math.ceil(R + 1);
  const dx: number[] = [], dy: number[] = [], w: number[] = [];
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++) {
      const v = Math.max(0, Math.min(1, R + 0.5 - Math.hypot(x, y)));
      if (v > 0) { dx.push(x); dy.push(y); w.push(v); }
    }
  return { off: Int32Array.from(dx.map((x, i) => x + dy[i] * GW)), dx: Int8Array.from(dx), dy: Int8Array.from(dy), w: Float32Array.from(w) };
}

export const toGrid = (x: number, y: number) => ({ gx: (x + SLAB_W / 2) * PX_PER_MM, gy: (SLAB_H / 2 - y) * PX_PER_MM });

/** Incremental simulation of one run onto a face grid (for the live animation). */
export class Sim {
  readonly s: Samples;
  k = 0;
  dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private stamp: Int32Array;
  private ker: ReturnType<typeof kernel>;
  constructor(readonly run: RunSpec, readonly grid: FaceGrid) {
    this.s = sampleRun(run);
    this.stamp = new Int32Array(GW * GH).fill(-1);
    this.ker = kernel(run.spotDia);
  }
  get done() { return this.k >= this.s.n; }
  get time() { return this.k ? this.s.tEnd[this.k - 1] : 0; }
  /** deposit every sample that ends at or before `t` (seconds of run time) */
  advanceTo(t: number) {
    const { s, grid, ker, stamp } = this;
    const { e, passes } = grid;
    const ns = s.spots;
    const kr = Math.ceil((this.run.spotDia / 2) * PX_PER_MM + 1);
    while (this.k < s.n && s.tEnd[this.k] <= t + 1e-9) {
      const k = this.k;
      const dt = s.dt[k];
      for (let i = 0; i < ns; i++) {
        const { gx, gy } = toGrid(s.xs[k * ns + i], s.ys[k * ns + i]);
        const cx = Math.round(gx), cy = Math.round(gy);
        if (cx < -kr || cy < -kr || cx >= GW + kr || cy >= GH + kr) continue;
        const inside = cx >= kr && cy >= kr && cx < GW - kr && cy < GH - kr;
        const base = cx + cy * GW;
        const key = k * 8 + i, prev = (k - 1) * 8 + i;
        for (let j = 0; j < ker.w.length; j++) {
          if (!inside) { const x = cx + ker.dx[j], y = cy + ker.dy[j]; if (x < 0 || y < 0 || x >= GW || y >= GH) continue; }
          const idx = base + ker.off[j];
          e[idx] += ker.w[j] * dt;
          if (ker.w[j] >= 0.5) {
            if (stamp[idx] !== prev && stamp[idx] !== key && passes[idx] < 65535) passes[idx]++;
            stamp[idx] = key;
          }
        }
        const d = this.dirty;
        const x0 = Math.max(0, cx - kr), y0 = Math.max(0, cy - kr), x1 = Math.min(GW - 1, cx + kr), y1 = Math.min(GH - 1, cy + kr);
        if (!d) this.dirty = { x0, y0, x1, y1 };
        else { d.x0 = Math.min(d.x0, x0); d.y0 = Math.min(d.y0, y0); d.x1 = Math.max(d.x1, x1); d.y1 = Math.max(d.y1, y1); }
      }
      this.k++;
    }
  }
  finish() { this.advanceTo(Infinity); return this; }
}

export function applyRun(grid: FaceGrid, run: RunSpec): FaceGrid {
  new Sim(run, grid).finish();
  grid.seconds += runDuration(run);
  grid.runs += 1;
  return grid;
}
export function gridForRuns(runs: RunSpec[]): FaceGrid {
  const g = newGrid();
  for (const r of runs) applyRun(g, r);
  return g;
}

/** 0..1 mark strength: ~1 s is pale and shallow, 125 s is a full bright dot. */
export function markStrength(e: number): number {
  if (e <= 0) return 0;
  return Math.min(1, Math.log1p(e / 0.5) / Math.log1p(FULL_EXPOSURE_S / 0.5));
}
/** Visible whiteness of the inlay for a given exposure. */
export function markAlpha(e: number): number {
  return Math.pow(markStrength(e), 0.85);
}
/** Approximate inlay depth (mm) – full exposure ~0.4 mm. */
export const markDepth = (e: number) => 0.4 * markStrength(e);

export function gridStats(g: FaceGrid): { maxE: number; maxPasses: number; markedMm2: number } {
  let maxE = 0, maxPasses = 0, cells = 0;
  for (let i = 0; i < g.e.length; i++) {
    const v = g.e[i];
    if (v > maxE) maxE = v;
    if (g.passes[i] > maxPasses) maxPasses = g.passes[i];
    if (v >= 0.05) cells++;
  }
  return { maxE, maxPasses, markedMm2: cells / (PX_PER_MM * PX_PER_MM) };
}

export function readCell(g: FaceGrid, x: number, y: number): { e: number; passes: number } | null {
  const { gx, gy } = toGrid(x, y);
  const cx = Math.floor(gx), cy = Math.floor(gy);
  if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) return null;
  return { e: g.e[cx + cy * GW], passes: g.passes[cx + cy * GW] };
}

// ------------------------------------------------------------------ vector paths for the pen plotter

export interface TraceOptions {
  /** skip parts of a pass whose exposure (spot dia / speed) is below this many seconds */
  minPassExposure: number;
  /** draw a small dot where a spot sat still at least `dwellMin` seconds */
  dwellDots: boolean;
  dwellMin: number;
  /** lift the pen where a pass retraces a line that was already drawn (longer than 1.5 mm) */
  skipRetrace: boolean;
  /** also dot small, compact bright spots in the exposure map (pass crossings) */
  brightDots: boolean;
  brightMin: number;
}
export const DEFAULT_TRACE: TraceOptions = { minPassExposure: 0.3, dwellDots: true, dwellMin: 2, skipRetrace: true, brightDots: false, brightMin: 4 };

/** Centres of compact (< 4 mm) regions whose exposure is at least `min` seconds. */
export function brightSpots(g: FaceGrid, min: number, maxSize = 4): Pt[] {
  const C = 5; // 0.5 mm cells
  const cw = Math.ceil(GW / C), ch = Math.ceil(GH / C);
  const on = new Uint8Array(cw * ch);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (g.e[x + y * GW] >= min) on[((x / C) | 0) + ((y / C) | 0) * cw] = 1;
  const seen = new Uint8Array(cw * ch);
  const res: Pt[] = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sx = 0, sy = 0, n = 0;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % cw, y = (j / cw) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      sx += x; sy += y; n++;
      for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ax, ny = y + ay;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const q = nx + ny * cw;
        if (on[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    const mm = C / PX_PER_MM;
    if ((maxX - minX + 1) * mm > maxSize || (maxY - minY + 1) * mm > maxSize) continue;
    res.push({ x: ((sx / n + 0.5) * mm) - SLAB_W / 2, y: SLAB_H / 2 - (sy / n + 0.5) * mm });
  }
  return res;
}

const circlePts = (c: Pt, r: number, n = 20): Polyline =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));

/** Spot trajectories on the slab face (slab mm), ready to place on the bed. */
export function traceRuns(runs: RunSpec[], o: TraceOptions = DEFAULT_TRACE, grid?: FaceGrid): { paths: Polyline[]; dots: number } {
  const out: Polyline[] = [];
  const dotCentres: Pt[] = [];
  let dots = 0;
  const CELL = 0.6;
  const cw = Math.ceil(SLAB_W / CELL) + 2, ch = Math.ceil(SLAB_H / CELL) + 2;
  const cov = new Float64Array(cw * ch).fill(-1);
  let cum = 0;
  const covIdx = (p: Pt) => {
    const x = Math.floor((p.x + SLAB_W / 2) / CELL) + 1, y = Math.floor((p.y + SLAB_H / 2) / CELL) + 1;
    return x < 0 || y < 0 || x >= cw || y >= ch ? -1 : x + y * cw;
  };
  for (const run of runs) {
    const s = sampleRun(run, 0.1);
    const D = Math.max(0.3, run.spotDia);
    for (let i = 0; i < s.spots; i++) {
      const pts: Pt[] = [];
      const st: number[] = []; // 0 off, 1 draw, 2 retrace
      const len: number[] = [];
      let dwellT = 0, dwellAt: Pt | null = null;
      const flushDwell = () => {
        if (dwellAt && o.dwellDots && dwellT >= o.dwellMin && !dotCentres.some((q) => Math.hypot(q.x - dwellAt!.x, q.y - dwellAt!.y) < D / 2)) {
          out.push(circlePts(dwellAt, D / 2));
          dotCentres.push(dwellAt);
          if (dwellT >= 30) out.push(circlePts(dwellAt, D / 4, 12));
          dots++;
        }
        dwellT = 0; dwellAt = null;
      };
      let prev: Pt | null = null;
      for (let k = 0; k < s.n; k++) {
        const p = { x: s.xs[k * s.spots + i], y: s.ys[k * s.spots + i] };
        const d = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0;
        const dt = s.dt[k];
        const speed = d / Math.max(1e-9, dt);
        if (d < 0.01 * Math.max(1, dt) && speed < 0.05) {
          // sitting still (dwell, or the centre spot during a rotation)
          if (dwellAt && Math.hypot(p.x - dwellAt.x, p.y - dwellAt.y) > D / 2) flushDwell();
          if (!dwellAt) dwellAt = p;
          dwellT += dt;
          pts.push(p); st.push(0); len.push(d);
          prev = p;
          continue;
        }
        if (dwellAt && Math.hypot(p.x - dwellAt.x, p.y - dwellAt.y) > D / 2) flushDwell();
        const exposed = D / Math.max(1e-9, speed) >= o.minPassExposure;
        let state = exposed ? 1 : 0;
        if (exposed && o.skipRetrace) {
          const c = covIdx(p);
          if (c >= 0) {
            if (cov[c] >= 0 && cov[c] < cum - 2) state = 2;
            cov[c] = cum;
          }
          cum += d;
        }
        pts.push(p); st.push(state); len.push(d);
        prev = p;
      }
      flushDwell();
      // short retrace runs (crossings) stay drawn
      for (let k = 0; k < st.length; ) {
        if (st[k] !== 2) { k++; continue; }
        let j = k, L = 0;
        while (j < st.length && st[j] === 2) { L += len[j]; j++; }
        if (L < 1.5) for (let q = k; q < j; q++) st[q] = 1;
        k = j;
      }
      let cur: Pt[] | null = null;
      for (let k = 0; k < pts.length; k++) {
        if (st[k] === 1) {
          if (!cur) cur = k > 0 && len[k] < 1 ? [pts[k - 1]] : [];
          cur.push(pts[k]);
        } else if (cur) { if (cur.length > 1) out.push(simplify(cur, 0.03)); cur = null; }
      }
      if (cur && cur.length > 1) out.push(simplify(cur, 0.03));
    }
  }
  if (grid && o.brightDots) {
    const D = Math.max(0.3, runs[runs.length - 1]?.spotDia ?? 1.75);
    for (const c of brightSpots(grid, o.brightMin)) {
      if (dotCentres.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < D * 1.5)) continue;
      out.push(circlePts(c, D / 2));
      dots++;
    }
  }
  const half = { minX: -SLAB_W / 2, maxX: SLAB_W / 2, minY: -SLAB_H / 2, maxY: SLAB_H / 2 };
  return { paths: clipPolylines(out, half), dots };
}

export interface Placement { scale: number; outline: boolean; dx: number; dy: number }
/** Slab mm -> bed mm, slab centred on `center`. Optional slab outline. */
export function placeOnBed(paths: Polyline[], center: Pt, p: Placement): Polyline[] {
  const k = p.scale;
  const map = (q: Pt): Pt => ({ x: center.x + p.dx + q.x * k, y: center.y + p.dy + q.y * k });
  const placed = paths.map((pl) => pl.map(map));
  if (p.outline) {
    const w = SLAB_W / 2, h = SLAB_H / 2;
    placed.unshift([{ x: -w, y: -h }, { x: w, y: -h }, { x: w, y: h }, { x: -w, y: h }, { x: -w, y: -h }].map(map));
  }
  return placed;
}

// ------------------------------------------------------------------ slabs (persisted)

export type Face = 'front' | 'back';
export interface SlabRecord {
  id: string;
  name: string;
  seed: number;
  rev: number;
  runs: Record<Face, RunSpec[]>;
}
export const newSlab = (name: string): SlabRecord => ({
  id: `slab-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
  name, seed: Math.floor(Math.random() * 2 ** 31), rev: 0, runs: { front: [], back: [] },
});
export function defaultSlabs(): SlabRecord[] {
  return ['Test A', 'Test B', 'Blank 1'].map((n, i) => ({ ...newSlab(n), id: `slab-default-${i}`, seed: 1337 + i * 7919 }));
}
