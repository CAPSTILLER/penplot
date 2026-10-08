/** Slab Simulator tab: laser + optic + moving stone slab, with PNG and pen-plotter G-code export. */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BedCanvas, type PreviewMove } from '../components/BedCanvas';
import { Num, Section, Segmented, Slider, Toggle } from '../components/Fields';
import {
  ACTIONS, DEFAULT_OPTICS, DEFAULT_TRACE, type Face, type FaceGrid, GH, GW, type Optics, PRESETS, PX_PER_MM, type RunSpec, SLAB_H, SLAB_W,
  Sim, type SlabRecord, type Step, type StepAction, type TraceOptions, capSequence1, cloneGrid, cubeSpacing, defaultSlabs, gridForRuns,
  gridStats, markAlpha, markDepth, mkStep, newSlab, placeOnBed, prismOffset, readCell, runDuration, spotPositions, stepId, traceRuns,
} from '../lib/slab';
import { canShareGcode, downloadGcode, gcodeFileName, shareGcode } from '../lib/exportFile';
import { DEFAULT_OPTIMIZE, optimize } from '../lib/optimize';
import { fmt, fmtDuration, generateGcode } from '../lib/gcode';
import { parseGcode } from '../lib/gcodeParse';
import { nozzleToPen, reachableArea } from '../lib/machine';
import { penStart } from '../lib/pipeline';
import type { Profile } from '../lib/profile';
import { type WalletKey, DRIFT_EVERY, SNAP_DWELL_S, parseAddress, walletSequence } from '../lib/wallet';

function usePersist<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return initial;
      const parsed = JSON.parse(raw);
      return Array.isArray(initial) ? parsed : { ...initial, ...parsed };
    } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full */ } }, [key, v]);
  return [v, setV] as const;
}

interface Store { slabs: SlabRecord[]; activeId: string; face: Face }
interface Cfg { optics: Optics; multiplier: number; circleDia: number; circleRev: number; spotDia: number; homeDwell: number; speed: number; seqName: string }
interface GcOpts extends TraceOptions { scale: number; outline: boolean; dx: number; dy: number }
interface Compare { on: boolean; otherId: string; otherFace: Face }

const WORLD_W = 172, WORLD_H = 128; // live view window (mm)
const BLUE = '#0052ff';

// ------------------------------------------------------------------ rendering

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const stoneCache = new Map<number, Uint8ClampedArray>();
/** Dusty base-blue stone with faint white veins, GW x GH RGBA. */
function stone(seed: number): Uint8ClampedArray {
  const hit = stoneCache.get(seed);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = GW; c.height = GH;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  g.fillStyle = 'rgb(44,74,140)';
  g.fillRect(0, 0, GW, GH);
  // soft mottling
  for (let i = 0; i < 140; i++) {
    const x = r() * GW, y = r() * GH, rad = 30 + r() * 160;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const light = r() > 0.5;
    grad.addColorStop(0, light ? 'rgba(120,140,180,0.10)' : 'rgba(20,40,90,0.12)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // faint veins
  g.lineCap = 'round';
  for (let v = 0; v < 9; v++) {
    let x = r() * GW, y = r() * GH, a = r() * Math.PI * 2;
    g.strokeStyle = `rgba(235,240,255,${0.07 + r() * 0.1})`;
    g.lineWidth = 1 + r() * 2.5;
    g.beginPath(); g.moveTo(x, y);
    const n = 40 + r() * 80;
    for (let i = 0; i < n; i++) {
      a += (r() - 0.5) * 0.7; x += Math.cos(a) * 14; y += Math.sin(a) * 14; g.lineTo(x, y);
      if (r() < 0.04) { g.stroke(); g.lineWidth = Math.max(0.6, g.lineWidth * 0.7); g.beginPath(); g.moveTo(x, y); }
    }
    g.stroke();
  }
  const img = g.getImageData(0, 0, GW, GH);
  // dust grain
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 16; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  stoneCache.set(seed, d);
  return d;
}

/** Writes stone + white inlay into `img` (GW x GH) for the given rect. */
function paintFace(img: ImageData, base: Uint8ClampedArray, grid: FaceGrid, x0 = 0, y0 = 0, x1 = GW - 1, y1 = GH - 1) {
  const d = img.data, e = grid.e;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = x + y * GW, p = i * 4;
      const a = markAlpha(e[i]);
      d[p] = base[p] + (246 - base[p]) * a;
      d[p + 1] = base[p + 1] + (249 - base[p + 1]) * a;
      d[p + 2] = base[p + 2] + (255 - base[p + 2]) * a;
      d[p + 3] = 255;
    }
  }
}

function faceCanvas(grid: FaceGrid, seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = GW; c.height = GH;
  const g = c.getContext('2d')!;
  const img = g.createImageData(GW, GH);
  paintFace(img, stone(seed), grid);
  g.putImageData(img, 0, 0);
  return c;
}

function FaceView({ grid, seed, label }: { grid: FaceGrid; seed: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.getContext('2d')!.drawImage(faceCanvas(grid, seed), 0, 0);
  }, [grid, seed]);
  return (
    <figure className="face-fig">
      <canvas ref={ref} width={GW} height={GH} className="face-canvas" />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ component

export function SlabTab({ profile, nav }: { profile: Profile; nav: ReactNode }) {
  const [store, setStore] = usePersist<Store>('penplot.slab.store.v1', { slabs: defaultSlabs(), activeId: 'slab-default-0', face: 'front' });
  const [cfg, setCfgRaw] = usePersist<Cfg>('penplot.slab.cfg.v1', {
    optics: DEFAULT_OPTICS, multiplier: 1, circleDia: 0, circleRev: 4, spotDia: 1.75, homeDwell: 30, speed: 20, seqName: 'Cap Sequence 1',
  });
  const [seq, setSeq] = usePersist<{ steps: Step[] }>('penplot.slab.steps.v1', { steps: capSequence1() });
  const [saved, setSaved] = usePersist<{ seqs: Record<string, Step[]> }>('penplot.slab.seqs.v1', { seqs: {} });
  const [gc, setGcRaw] = usePersist<GcOpts>('penplot.slab.gcode.v1', { ...DEFAULT_TRACE, scale: 1, outline: true, dx: 0, dy: 0 });
  const [cmp, setCmpRaw] = usePersist<Compare>('penplot.slab.compare.v1', { on: false, otherId: 'slab-default-1', otherFace: 'front' });
  const [wallet, setWallet] = usePersist<{ addr: string; key: WalletKey }>('penplot.slab.wallet.v1', { addr: '0x1a72f7314297B0b8f6808A9248969A8108F49890', key: 'raw' });
  const [pendingRun, setPendingRun] = useState(false);
  const setCfg = (p: Partial<Cfg>) => setCfgRaw((o) => ({ ...o, ...p }));
  const setOptics = (p: Partial<Optics>) => setCfgRaw((o) => ({ ...o, optics: { ...o.optics, ...p } }));
  const setGc = (p: Partial<GcOpts>) => setGcRaw((o) => ({ ...o, ...p }));
  const setCmp = (p: Partial<Compare>) => setCmpRaw((o) => ({ ...o, ...p }));

  const slabs = store.slabs.length ? store.slabs : defaultSlabs();
  const slab = slabs.find((s) => s.id === store.activeId) ?? slabs[0];
  const face = store.face;
  const runs = slab.runs[face];
  const patchSlab = (id: string, fn: (s: SlabRecord) => SlabRecord) => setStore((st) => ({ ...st, slabs: st.slabs.map((s) => (s.id === id ? fn(s) : s)) }));

  // ---- exposure grids (recomputed from the saved run list, cached per slab revision)
  const cache = useRef(new Map<string, FaceGrid>());
  const gridOf = useCallback((s: SlabRecord, f: Face): FaceGrid => {
    const key = `${s.id}:${f}:${s.rev}`;
    let g = cache.current.get(key);
    if (!g) {
      g = gridForRuns(s.runs[f]);
      for (const k of cache.current.keys()) if (k.startsWith(`${s.id}:${f}:`)) cache.current.delete(k);
      cache.current.set(key, g);
    }
    return g;
  }, []);
  const grid = useMemo(() => gridOf(slab, face), [gridOf, slab, face]);
  const stats = useMemo(() => gridStats(grid), [grid]);

  const run: RunSpec = useMemo(() => ({
    name: cfg.seqName || 'Sequence', steps: seq.steps, optics: cfg.optics, multiplier: cfg.multiplier, circleDia: cfg.circleDia,
    circleRev: cfg.circleRev, spotDia: cfg.spotDia, homeDwell: cfg.homeDwell,
  }), [cfg, seq.steps]);
  const dur = runDuration(run);

  // ---- live canvas
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(360);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const height = Math.round((width * WORLD_H) / WORLD_W);
  const face2d = useRef<{ c: HTMLCanvasElement; img: ImageData; g: CanvasRenderingContext2D } | null>(null);
  const [readout, setReadout] = useState<{ x: number; y: number } | null>(null);
  const anim = useRef<{ sim: Sim; t: number; last: number; raf: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [prog, setProg] = useState<{ t: number; step: number } | null>(null);

  const showHome = runs.length === 0;
  const draw = useCallback((pose: { tx: number; ty: number; rot: number; bx: number; by: number } | null) => {
    const c = canvasRef.current, f = face2d.current;
    if (!c || !f) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (c.width !== Math.round(width * dpr)) { c.width = Math.round(width * dpr); c.height = Math.round(height * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#1b1d22';
    g.fillRect(0, 0, width, height);
    const s = width / WORLD_W, cx = width / 2, cy = height / 2;
    const p = pose ?? { tx: 0, ty: 0, rot: 0, bx: 0, by: 0 };
    // slab
    g.save();
    g.translate(cx + p.tx * s, cy - p.ty * s);
    g.rotate((p.rot * Math.PI) / 180);
    g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 14; g.shadowOffsetY = 4;
    g.fillStyle = '#16264a';
    g.fillRect((-SLAB_W / 2) * s, (-SLAB_H / 2) * s, SLAB_W * s, SLAB_H * s);
    g.shadowColor = 'transparent';
    g.imageSmoothingEnabled = true;
    g.drawImage(f.c, (-SLAB_W / 2) * s, (-SLAB_H / 2) * s, SLAB_W * s, SLAB_H * s);
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 1;
    g.strokeRect((-SLAB_W / 2) * s, (-SLAB_H / 2) * s, SLAB_W * s, SLAB_H * s);
    if (readout && !pose) {
      g.strokeStyle = '#d4a017'; g.lineWidth = 1.5;
      const x = readout.x * s, y = -readout.y * s;
      g.beginPath(); g.moveTo(x - 8, y); g.lineTo(x + 8, y); g.moveTo(x, y - 8); g.lineTo(x, y + 8); g.stroke();
    }
    g.restore();
    // beam spots (fixed in the world)
    const spots = spotPositions(cfg.optics);
    const r = Math.max(2.5, (cfg.spotDia / 2) * s);
    for (const q of spots) {
      const x = cx + (q.x + p.bx) * s, y = cy - (q.y + p.by) * s;
      if (pose) {
        g.save();
        g.shadowColor = BLUE; g.shadowBlur = 16;
        g.fillStyle = 'rgba(80,140,255,0.95)';
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        g.restore();
        g.fillStyle = '#e8f0ff';
        g.beginPath(); g.arc(x, y, Math.max(1, r * 0.4), 0, Math.PI * 2); g.fill();
      } else if (showHome) {
        g.strokeStyle = 'rgba(90,150,255,0.85)'; g.lineWidth = 1.2;
        g.beginPath(); g.arc(x, y, r + 2, 0, Math.PI * 2); g.stroke();
      }
    }
    g.fillStyle = 'rgba(232,232,232,0.7)';
    g.font = '700 10px ui-monospace, Menlo, monospace';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(`${slab.name.toUpperCase()} · ${face.toUpperCase()} FACE · ${SLAB_W}×${SLAB_H}×6 mm`, 8, 7);
    if (pose) {
      g.textAlign = 'right';
      g.fillText(`X ${fmt(p.tx)} Y ${fmt(p.ty)} ${fmt(p.rot)}°`, width - 8, 7);
    }
  }, [width, height, cfg.optics, cfg.spotDia, slab.name, face, readout, showHome]);

  // repaint the face image whenever the committed grid changes
  useEffect(() => {
    if (anim.current) return;
    const c = document.createElement('canvas');
    c.width = GW; c.height = GH;
    const g = c.getContext('2d')!;
    const img = g.createImageData(GW, GH);
    paintFace(img, stone(slab.seed), grid);
    g.putImageData(img, 0, 0);
    face2d.current = { c, img, g };
    draw(null);
  }, [grid, slab.seed]);
  useEffect(() => { if (!anim.current) draw(null); }, [draw]);

  const commit = (sim: Sim) => {
    const g = sim.grid;
    g.seconds += runDuration(sim.run);
    g.runs += 1;
    const rev = slab.rev + 1;
    cache.current.set(`${slab.id}:${face}:${rev}`, g);
    patchSlab(slab.id, (s) => ({ ...s, rev, runs: { ...s.runs, [face]: [...s.runs[face], JSON.parse(JSON.stringify(sim.run))] } }));
  };
  const stop = (keep: boolean) => {
    const a = anim.current;
    if (!a) return;
    cancelAnimationFrame(a.raf);
    anim.current = null;
    setRunning(false);
    setProg(null);
    if (keep) { a.sim.finish(); commit(a.sim); }
    else {
      // repaint from the committed grid
      const f = face2d.current;
      if (f) { paintFace(f.img, stone(slab.seed), grid); f.g.putImageData(f.img, 0, 0); }
      draw(null);
    }
  };
  const start = (instant: boolean) => {
    if (anim.current || !seq.steps.length) return;
    setReadout(null);
    const sim = new Sim(run, cloneGrid(grid));
    if (instant || sim.s.total <= 0) { sim.finish(); commit(sim); return; }
    const a = { sim, t: 0, last: performance.now(), raf: 0 };
    anim.current = a;
    setRunning(true);
    let lastUi = 0;
    const tick = (now: number) => {
      if (anim.current !== a) return;
      a.t += ((now - a.last) / 1000) * cfg.speed;
      a.last = now;
      sim.advanceTo(a.t);
      const f = face2d.current;
      if (f && sim.dirty) {
        const d = sim.dirty;
        paintFace(f.img, stone(slab.seed), sim.grid, d.x0, d.y0, d.x1, d.y1);
        f.g.putImageData(f.img, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1);
        sim.dirty = null;
      }
      const k = Math.max(0, Math.min(sim.s.n - 1, sim.k - 1));
      const S = sim.s;
      draw({ tx: S.tx[k], ty: S.ty[k], rot: S.rot[k], bx: S.bx[k], by: S.by[k] });
      if (now - lastUi > 120) { lastUi = now; setProg({ t: Math.min(a.t, S.total), step: S.step[k] }); }
      if (sim.done) {
        anim.current = null;
        setRunning(false);
        setProg(null);
        commit(sim);
        return;
      }
      a.raf = requestAnimationFrame(tick);
    };
    a.raf = requestAnimationFrame(tick);
  };
  useEffect(() => () => { if (anim.current) cancelAnimationFrame(anim.current.raf); anim.current = null; }, []);

  const onCanvasTap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (running) return;
    const r = e.currentTarget.getBoundingClientRect();
    const s = width / WORLD_W;
    const x = (e.clientX - r.left - width / 2) / s, y = -(e.clientY - r.top - height / 2) / s;
    if (Math.abs(x) > SLAB_W / 2 || Math.abs(y) > SLAB_H / 2) { setReadout(null); return; }
    setReadout({ x, y });
  };
  const cell = readout ? readCell(grid, readout.x, readout.y) : null;

  // ---- slab management
  const addSlab = () => {
    const name = prompt('Name for the new blank slab', `Blank ${slabs.length + 1}`);
    if (!name) return;
    const s = newSlab(name.slice(0, 40));
    setStore((st) => ({ ...st, slabs: [...st.slabs, s], activeId: s.id }));
  };
  const renameSlab = () => {
    const name = prompt('Rename slab', slab.name);
    if (name) patchSlab(slab.id, (s) => ({ ...s, name: name.slice(0, 40) }));
  };
  const deleteSlab = () => {
    if (slabs.length < 2 || !confirm(`Delete slab "${slab.name}" and both faces?`)) return;
    setStore((st) => { const rest = st.slabs.filter((s) => s.id !== slab.id); return { ...st, slabs: rest, activeId: rest[0].id }; });
  };
  const clearFace = () => {
    if (!runs.length || !confirm(`Clear all marks on ${slab.name} — ${face} face?`)) return;
    patchSlab(slab.id, (s) => ({ ...s, rev: s.rev + 1, runs: { ...s.runs, [face]: [] } }));
  };
  const undoRun = () => patchSlab(slab.id, (s) => ({ ...s, rev: s.rev + 1, runs: { ...s.runs, [face]: s.runs[face].slice(0, -1) } }));

  // ---- sequence editing
  const setSteps = (fn: (s: Step[]) => Step[]) => setSeq((o) => ({ steps: fn(o.steps) }));
  const patchStep = (id: string, p: Partial<Step>) => setSteps((l) => l.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const moveStep = (i: number, d: number) => setSteps((l) => { const j = i + d; if (j < 0 || j >= l.length) return l; const n = l.slice(); [n[i], n[j]] = [n[j], n[i]]; return n; });
  const seqNames = [...Object.keys(PRESETS), ...Object.keys(saved.seqs).filter((n) => !PRESETS[n])];
  const loadSeq = (name: string) => {
    const steps = PRESETS[name] ? PRESETS[name]() : (saved.seqs[name] ?? []).map((s) => ({ ...s, id: stepId() }));
    setSeq({ steps });
    setCfg({ seqName: name });
  };
  const saveSeq = () => {
    const name = prompt('Save sequence as', PRESETS[cfg.seqName] ? `${cfg.seqName} (edited)` : cfg.seqName || 'My sequence');
    if (!name) return;
    setSaved((o) => ({ seqs: { ...o.seqs, [name.slice(0, 40)]: seq.steps } }));
    setCfg({ seqName: name.slice(0, 40) });
  };
  const deleteSeq = () => {
    if (PRESETS[cfg.seqName] || !saved.seqs[cfg.seqName] || !confirm(`Delete saved sequence "${cfg.seqName}"?`)) return;
    setSaved((o) => { const n = { ...o.seqs }; delete n[cfg.seqName]; return { seqs: n }; });
  };

  // ---- wallet sequence
  const parsedAddr = useMemo(() => parseAddress(wallet.addr), [wallet.addr]);
  const walletSeq = useMemo(() => (parsedAddr.ok ? walletSequence(parsedAddr.checksum, wallet.key) : null), [parsedAddr, wallet.key]);
  const generate = (andRun: boolean) => {
    if (!walletSeq || running) return;
    const steps = walletSeq.steps.map((x) => ({ ...x, id: stepId() }));
    setSeq({ steps });
    setCfg({ seqName: walletSeq.name, optics: walletSeq.optics });
    setSaved((o) => ({ seqs: { ...o.seqs, [walletSeq.name]: steps } }));
    if (andRun) setPendingRun(true);
  };
  useEffect(() => { if (pendingRun) { setPendingRun(false); start(false); } }, [pendingRun, seq.steps]);

  // ---- PNG export
  const [note, setNote] = useState<string | null>(null);
  const [gcNote, setGcNote] = useState<string | null>(null);
  useEffect(() => { setNote(null); setGcNote(null); }, [slab.id, face]);
  const exportPng = async () => {
    const pad = 90;
    const c = document.createElement('canvas');
    c.width = GW + pad * 2; c.height = GH + pad * 2;
    const g = c.getContext('2d')!;
    g.fillStyle = '#8c8c8c';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(faceCanvas(grid, slab.seed), pad, pad);
    const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob) return;
    const name = `${gcodeFileName(`slab-${slab.name}-${face}`).replace(/\.gcode$/, '')}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        await navigator.share({ files: [file], title: name });
        setNote(`Shared ${name}`);
        return;
      }
    } catch (e) { if ((e as DOMException)?.name === 'AbortError') return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
    setNote(`Saved ${name}`);
  };

  // ---- G-code
  const area = useMemo(() => reachableArea(profile), [profile]);
  const job = useMemo(() => {
    const t = traceRuns(runs, gc, grid);
    const center = { x: (area.minX + area.maxX) / 2, y: (area.minY + area.maxY) / 2 };
    const placed = placeOnBed(t.paths, center, { scale: gc.scale, outline: gc.outline, dx: gc.dx, dy: gc.dy });
    const o = optimize(placed, { ...DEFAULT_OPTIMIZE }, penStart(profile));
    const notes = [
      `Slab Simulator: ${slab.name}, ${face} face, ${runs.length} run(s): ${runs.map((r) => r.name).join(', ') || 'none'}`,
      `Slab ${SLAB_W} x ${SLAB_H} mm at ${fmt(gc.scale * 100)}%, centred on the reachable area${gc.outline ? ', with outline' : ''}`,
      `Passes under ${fmt(gc.minPassExposure)} s exposure skipped; ${t.dots} dwell/bright dot(s)`,
    ];
    const result = generateGcode(o.paths.map((pts) => ({ pts })), profile, { title: `Slab ${slab.name} ${face}`, notes, boundsMode: 'clip' });
    return { result, dots: t.dots, strokes: t.paths.length, file: gcodeFileName(`slab-${slab.name}-${face}`) };
  }, [runs, gc, grid, area, profile, slab.name, face]);
  const moves: PreviewMove[] = useMemo(() => {
    const parsed = parseGcode(job.result.gcode, { x: profile.homeX, y: profile.homeY });
    const m = parsed.moves.map((mv) => ({ kind: mv.kind, from: nozzleToPen(mv.from, profile), to: nozzleToPen(mv.to, profile) }));
    let last = m.length;
    while (last > 0 && m[last - 1].kind === 'travel') last--;
    return m.slice(0, last);
  }, [job, profile]);
  const [showTravel, setShowTravel] = useState(false);
  const [canShare] = useState(() => canShareGcode());
  const r = job.result;
  const hasMarks = runs.length > 0 && r.paths > (gc.outline ? 1 : 0);

  const other = slabs.find((s) => s.id === cmp.otherId) ?? slabs[0];
  const otherGrid = cmp.on ? gridOf(other, cmp.otherFace) : null;
  const unitOf = (a: StepAction) => ACTIONS.find((x) => x.value === a)?.unit ?? '';
  const optic = cfg.optics;

  return (
    <div className="layout slab-tab">
      <div className="col-preview">
        <div className="panel preview">
          <span className="rivet tl" /><span className="rivet tr" /><span className="rivet bl" /><span className="rivet br" />
          <div className="preview-head"><span>Slab Simulator · laser fixed, slab moves</span></div>
          <div className="bed-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} className="bed slab-live" style={{ width, height }} onPointerDown={onCanvasTap} role="img" aria-label="Slab under the laser" />
          </div>
          <div className="scrub">
            {running ? (
              <>
                <button type="button" className="btn" onClick={() => stop(false)}>■ Cancel</button>
                <button type="button" className="btn" onClick={() => stop(true)}>⏭ Finish</button>
              </>
            ) : (
              <>
                <button type="button" className="btn gold" onClick={() => start(false)} disabled={!seq.steps.length}>▶ Run</button>
                <button type="button" className="btn" onClick={() => start(true)} disabled={!seq.steps.length}>⚡ Instant</button>
              </>
            )}
            <select className="select speed" value={cfg.speed} onChange={(e) => setCfg({ speed: Number(e.target.value) })} aria-label="Playback speed">
              {[5, 10, 20, 40, 100].map((v) => <option key={v} value={v}>{v}× speed</option>)}
            </select>
          </div>
          <div className="scrub-info">
            {prog ? (
              <span>{fmtDuration(prog.t)} / {fmtDuration(dur)} · {prog.step < 0 ? 'home dwell' : `step ${prog.step + 1}`}</span>
            ) : cell && readout ? (
              <span className="readout">X {fmt(Math.round(readout.x * 10) / 10)} Y {fmt(Math.round(readout.y * 10) / 10)} mm · <b>{cell.e.toFixed(1)} s</b> · {cell.passes} pass{cell.passes === 1 ? '' : 'es'} · depth ≈{markDepth(cell.e).toFixed(2)} mm</span>
            ) : (
              <span>Tap the slab to read the exposure at a spot.</span>
            )}
          </div>
        </div>

        <div className="panel export">
          <div className="export-stats">
            <div><b>{fmtDuration(grid.seconds)}</b><span>laser time</span></div>
            <div><b>{grid.runs}</b><span>runs</span></div>
            <div><b>{stats.maxE.toFixed(1)}s</b><span>max exposure</span></div>
            <div><b>{stats.maxPasses}</b><span>max passes</span></div>
            <div><b>{Math.round(stats.markedMm2)}</b><span>mm² marked</span></div>
          </div>
          <div className="btn-row three">
            <button type="button" className="btn" onClick={exportPng}>🖼 PNG</button>
            <button type="button" className="btn" onClick={undoRun} disabled={!runs.length || running}>↶ Undo run</button>
            <button type="button" className="btn danger" onClick={clearFace} disabled={!runs.length || running}>✕ Clear face</button>
          </div>
          {note && <p className="note tiny ok-note">{note}</p>}
          <Toggle label="Compare side by side" checked={cmp.on} onChange={(on) => setCmp({ on })} />
          {cmp.on && otherGrid && (
            <>
              <div className="grid2">
                <label className="field"><span className="field-label">Compare with</span>
                  <select className="select" value={other.id} onChange={(e) => setCmp({ otherId: e.target.value })}>
                    {slabs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="field"><span className="field-label">Face</span>
                  <Segmented value={cmp.otherFace} onChange={(f) => setCmp({ otherFace: f })} options={[{ value: 'front', label: 'Front' }, { value: 'back', label: 'Back' }]} />
                </label>
              </div>
              <div className="face-pair">
                <FaceView grid={grid} seed={slab.seed} label={`${slab.name} · ${face} · ${grid.runs} run(s)`} />
                <FaceView grid={otherGrid} seed={other.seed} label={`${other.name} · ${cmp.otherFace} · ${otherGrid.runs} run(s)`} />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="col-controls">
        {nav}
        <div className="panel controls">
          <div className="panel-body">
            <Section title="Slab">
              <div className="profile-row">
                <select className="select" value={slab.id} onChange={(e) => setStore((st) => ({ ...st, activeId: e.target.value }))} aria-label="Slab">
                  {slabs.map((s) => <option key={s.id} value={s.id}>{s.name}{s.runs.front.length + s.runs.back.length ? '' : ' (blank)'}</option>)}
                </select>
                <button type="button" className="btn" onClick={addSlab}>+ New</button>
                <button type="button" className="btn" onClick={renameSlab}>Rename</button>
                <button type="button" className="btn danger" onClick={deleteSlab} disabled={slabs.length < 2}>✕</button>
              </div>
              <Segmented label="Face" value={face} onChange={(f) => setStore((st) => ({ ...st, face: f }))} options={[
                { value: 'front', label: `Front face (${slab.runs.front.length})` }, { value: 'back', label: `Back face (${slab.runs.back.length})` },
              ]} />
              <p className="note">150 × 68 × 6 mm stone. Each face keeps its marks (saved on this device) until you clear it. ~1 s = pale and shallow, ~125 s = full bright dot.</p>
            </Section>

            <Section title="Laser & optic">
              <Segmented label="Optic" value={optic.kind} onChange={(kind) => setOptics({ kind })} options={[
                { value: 'none', label: 'None' }, { value: 'prism', label: 'Prism' }, { value: 'cube', label: 'Diffraction cube' },
              ]} />
              {optic.kind !== 'none' && (
                <Slider label="Optic distance from zero" value={optic.distance} onChange={(distance) => setOptics({ distance })} min={-40} max={50} step={1}
                  format={(v) => `${v > 0 ? '+' : ''}${v} mm (${50 + v} mm above)`} />
              )}
              {optic.kind === 'prism' && (
                <Slider label="Prism bend angle" value={optic.prismAngle} onChange={(prismAngle) => setOptics({ prismAngle })} min={0} max={40} step={0.5} format={(v) => `${v}°`} />
              )}
              <p className="note optic-note">
                {optic.kind === 'none' && <>One spot at the slab centre.</>}
                {optic.kind === 'prism' && <>Beam bent <b>{fmt(optic.prismAngle)}°</b> → one spot <b>{prismOffset(optic).toFixed(1)} mm</b> right of centre.</>}
                {optic.kind === 'cube' && <>7 spots in a row, <b>{cubeSpacing(optic.distance).toFixed(1)} mm</b> apart (zero = 50 mm above the slab = 18.8 mm).</>}
              </p>
              <div className="grid2">
                <Num label="Spot size" value={cfg.spotDia} onChange={(spotDia) => setCfg({ spotDia })} min={0.5} max={4} step={0.25} unit="mm" />
                <Num label="Home dwell" value={cfg.homeDwell} onChange={(homeDwell) => setCfg({ homeDwell })} min={0} max={600} step={5} unit="s" hint="Laser on at home before step 1" />
              </div>
            </Section>

            <Section title="Wallet sequence" right={walletSeq ? <span className="pill">{walletSeq.decoded.length} keys</span> : undefined}>
              <label className="field"><span className="field-label">EVM wallet address</span>
                <input className="num txt wallet-in" type="text" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={wallet.addr}
                  onChange={(e) => setWallet((o) => ({ ...o, addr: e.target.value }))} placeholder="0x…" aria-label="Wallet address" />
              </label>
              {parsedAddr.ok ? (
                <p className="note wallet-ok">✓ <code>{parsedAddr.checksum}</code>{parsedAddr.fixedCase ? ' (checksum casing applied)' : ' (checksum OK)'}</p>
              ) : <p className="warn">{parsedAddr.error}</p>}
              <Segmented label="Key" value={wallet.key} onChange={(key) => setWallet((o) => ({ ...o, key }))} options={[{ value: 'raw', label: 'Raw key' }, { value: 'hashed', label: 'Hashed key' }]} />
              <div className="grid2">
                <button type="button" className="btn" onClick={() => generate(false)} disabled={!walletSeq || running}>Generate</button>
                <button type="button" className="btn gold" onClick={() => generate(true)} disabled={!walletSeq || running}>Generate &amp; run</button>
              </div>
              {walletSeq && (
                <details className="wallet-decoded">
                  <summary>{walletSeq.name} · {walletSeq.opticText} · {walletSeq.steps.length} steps</summary>
                  <p className="note">Source: <code>{walletSeq.source}</code></p>
                  <ol className="decoded" start={1}>
                    <li><b>{walletSeq.source.slice(0, 2)}</b> → {walletSeq.opticText}</li>
                    {walletSeq.decoded.map((d) => <li key={d.pos}><b>{d.ch}</b> → {d.text}</li>)}
                  </ol>
                </details>
              )}
              <details className="wallet-key">
                <summary>Key — how an address becomes a sequence</summary>
                <ul className="steps">
                  <li><b>Raw</b> uses the 40 address characters with checksum casing. <b>Hashed</b> uses keccak-256 of the 20 address bytes (first 40 of 64 hex chars), cased with the same checksum rule applied to the hash.</li>
                  <li>The <b>first 2 chars</b> (one byte) pick the optic: byte mod 3 → none / prism / cube. High nibble → optic distance 0 to −20 mm; bits 1–3 → prism angle 5–26°.</li>
                  <li>The other <b>38 chars are 38 steps</b>, in order. Each char is a number 0–15: top 2 bits = action (0 move up/down, 1 move left/right, 2 rotate, 3 circle/dwell), low 2 bits = size: moves 1/2/3/5 mm, rotations 5/10/15/30°, circles ⌀1/2/3/5 mm (dwells 2/3/4/6 s).</li>
                  <li><b>Direction:</b> capital letter = up / right / CW / circle; small letter = down / left / CCW / dwell. Digits have no case: positive when digit + position is even.</li>
                  <li><b>Timing:</b> even steps move steadily (1 mm per s, 5° per 2 s, circle in 4 s). Odd steps snap in 1 s and then dwell {SNAP_DWELL_S} s, which burns a dot.</li>
                  <li><b>Stays on the slab:</b> if a move would take the centre spot past the safe box (±45 mm sideways, tighter with the cube; ±20 mm up/down; rotation ±35°, tighter with the cube), that move flips direction. Every {DRIFT_EVERY} steps the slab also drifts 25% of the way back to centre.</li>
                  <li>Same address + same key = the same sequence, every time. Generated sequences are saved by name and can be edited like any other.</li>
                </ul>
              </details>
            </Section>

            <Section title="Motion sequence" right={<span className="pill">{fmtDuration(dur)}</span>}>
              <div className="profile-row">
                <select className="select" value={seqNames.includes(cfg.seqName) ? cfg.seqName : ''} onChange={(e) => e.target.value && loadSeq(e.target.value)} aria-label="Load sequence">
                  {!seqNames.includes(cfg.seqName) && <option value="">{cfg.seqName || 'Unsaved'}</option>}
                  {seqNames.map((n) => <option key={n} value={n}>{n}{PRESETS[n] ? ' (preset)' : ''}</option>)}
                </select>
                <button type="button" className="btn" onClick={saveSeq}>Save as…</button>
                <button type="button" className="btn danger" onClick={deleteSeq} disabled={!!PRESETS[cfg.seqName] || !saved.seqs[cfg.seqName]}>✕</button>
              </div>
              <ol className="step-list">
                {seq.steps.map((s, i) => (
                  <li key={s.id} className={prog && prog.step === i ? 'step-card live' : 'step-card'}>
                    <div className="step-top">
                      <b className="step-n">{i + 1}</b>
                      <select className="select" value={s.action} onChange={(e) => patchStep(s.id, { action: e.target.value as StepAction })} aria-label={`Step ${i + 1} action`}>
                        {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                      </select>
                      <button type="button" className="btn ico" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                      <button type="button" className="btn ico" onClick={() => moveStep(i, 1)} disabled={i === seq.steps.length - 1} aria-label="Move down">↓</button>
                      <button type="button" className="btn ico danger" onClick={() => setSteps((l) => l.filter((x) => x.id !== s.id))} aria-label="Delete step">✕</button>
                    </div>
                    <div className="step-grid">
                      {s.action !== 'dwell' ? <Num label="Amount" value={s.amount} onChange={(amount) => patchStep(s.id, { amount })} step={1} min={0} unit={unitOf(s.action)} /> : <span className="field"><span className="field-label">Amount</span><span className="step-na">—</span></span>}
                      <Num label="Time" value={s.duration} onChange={(duration) => patchStep(s.id, { duration })} step={1} min={0} unit="s" />
                      <Num label="Repeat" value={s.repeat} onChange={(repeat) => patchStep(s.id, { repeat: Math.round(repeat) })} step={1} min={1} max={10000} decimals={0} unit="×" />
                    </div>
                  </li>
                ))}
              </ol>
              <div className="btn-row">
                <button type="button" className="btn" onClick={() => setSteps((l) => [...l, mkStep('up', 1, 1, 1)])}>+ Step</button>
                <button type="button" className="btn" onClick={() => setSteps((l) => [...l, mkStep('dwell', 0, 5, 1)])}>+ Dwell</button>
                <button type="button" className="btn" onClick={() => setSteps((l) => [...l, mkStep('circle', 3, 4, 1)])}>+ Circle</button>
                <button type="button" className="btn" onClick={() => loadSeq('Cap Sequence 1')}>Preset</button>
              </div>
              <div className="grid2">
                <Num label="Time multiplier" value={cfg.multiplier} onChange={(multiplier) => setCfg({ multiplier })} min={0.1} max={20} step={0.5} unit="×" hint="2× = every step twice as long (double exposure)" />
                <Num label="Circle while moving" value={cfg.circleDia} onChange={(circleDia) => setCfg({ circleDia })} min={0} max={20} step={0.5} unit="mm" hint="0 = off. Spot traces this circle the whole run" />
              </div>
              {cfg.circleDia > 0 && <Num label="Circle speed" value={cfg.circleRev} onChange={(circleRev) => setCfg({ circleRev })} min={0.2} max={60} step={0.5} unit="s/rev" />}
            </Section>

            <Section title="Pen plot G-code" right={<span className="pill">{job.strokes} strokes</span>}>
              <p className="note">Turns the spot trails on this face into pen strokes: every pass becomes a line, long dwells become small dots, and the slab is centred on your {profile.name} bed. Uses your Printer profile (pen heights, offset, lifts).</p>
              <div className="grid2">
                <Num label="Skip passes under" value={gc.minPassExposure} onChange={(minPassExposure) => setGc({ minPassExposure })} min={0} max={30} step={0.1} unit="s" hint="Fast moves leave pale marks; skip them" />
                <Num label="Scale" value={Math.round(gc.scale * 100)} onChange={(v) => setGc({ scale: v / 100 })} min={10} max={140} step={5} unit="%" decimals={0} />
                <Num label="Nudge X" value={gc.dx} onChange={(dx) => setGc({ dx })} step={1} unit="mm" />
                <Num label="Nudge Y" value={gc.dy} onChange={(dy) => setGc({ dy })} step={1} unit="mm" />
              </div>
              <Toggle label="Dots for dwells" checked={gc.dwellDots} onChange={(dwellDots) => setGc({ dwellDots })} hint={`Where a spot sat still ≥ ${gc.dwellMin} s`} />
              <Toggle label="Dots for bright crossings" checked={gc.brightDots} onChange={(brightDots) => setGc({ brightDots })} hint={`Small spots with ≥ ${gc.brightMin} s exposure`} />
              <Toggle label="Don't redraw the same line" checked={gc.skipRetrace} onChange={(skipRetrace) => setGc({ skipRetrace })} hint="Lift the pen where a pass retraces a drawn line" />
              <Toggle label="Draw slab outline" checked={gc.outline} onChange={(outline) => setGc({ outline })} />
              <div className="slab-bed">
                <BedCanvas profile={profile} area={area} moves={moves} progress={null} showTravel={showTravel} />
              </div>
              <Toggle label="Show pen-up travel" checked={showTravel} onChange={setShowTravel} />
              <div className="export-stats">
                <div><b>{fmtDuration(r.estSeconds)}</b><span>est. time</span></div>
                <div><b>{r.lineCount.toLocaleString()}</b><span>lines</span></div>
                <div><b>{Math.round(r.drawMm).toLocaleString()}</b><span>mm drawn</span></div>
                <div><b>{job.dots}</b><span>dots</span></div>
                <div><b>{r.penLifts}</b><span>pen lifts</span></div>
              </div>
              {r.warnings.map((w) => <p key={w} className="warn">{w}</p>)}
              {!profile.penZCalibrated && <p className="warn">Pen-down Z isn't calibrated yet — run the pen-height test in Calibrate first.</p>}
              <div className={canShare ? 'export-btns two' : 'export-btns'}>
                <button type="button" className="btn gold big" disabled={!hasMarks} onClick={() => setGcNote(`Saved as ${downloadGcode(r.gcode, job.file)}`)}>⬇ Download {job.file}</button>
                {canShare && (
                  <button type="button" className="btn big share" disabled={!hasMarks} onClick={async () => {
                    try { if (await shareGcode(r.gcode, job.file)) setGcNote(`Shared ${job.file}`); } catch { setGcNote('Sharing failed — use Download instead.'); }
                  }}>⇪ Share / Save to Files</button>
                )}
              </div>
              {!hasMarks && <p className="note tiny">Run a sequence on this face first.</p>}
              {gcNote && <p className="note tiny ok-note">{gcNote}</p>}
              <p className="note tiny">Pen-down Z {fmt(profile.penDownZ)} · pen-up Z {fmt(profile.penUpZ)} · offset X {fmt(profile.penOffsetX)} Y {fmt(profile.penOffsetY)} · {PX_PER_MM} px/mm sim grid.</p>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
