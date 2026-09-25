import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Gear } from './components/Gear';
import { BedCanvas, type BoardOverlay, type BoardPointer, HANDLE_PX, HIT_PX, type PreviewMove } from './components/BedCanvas';
import { Segmented, Toggle } from './components/Fields';
import { DesignPanel, type ImageSettings, type SourceKind, type TextSettings } from './panels/DesignPanel';
import { BoardPanel } from './panels/BoardPanel';
import { CalibratePanel, type CalibSettings } from './panels/CalibratePanel';
import { PrinterPanel } from './panels/PrinterPanel';
import { designCenter, flipY } from './lib/design';
import {
  type GridOptions, type Hit, type Instance, type PaperSettings, dragInstance, fitInstance, gridLayout, hitTest, intersect,
  makeInstance, newId, paperRect, paperSize, resizeInstance,
} from './lib/board';
import { canShareGcode, downloadGcode, gcodeFileName, shareGcode, textSlug } from './lib/exportFile';
import type { Polyline } from './lib/geometry';
import { parseSvg } from './lib/svg';
import { renderText } from './lib/hershey';
import { type Gray, traceImage } from './lib/trace';
import { loadImageGray } from './lib/image';
import { DEFAULT_OPTIMIZE, type OptimizeOptions, optimize } from './lib/optimize';
import { fmt, fmtDuration, generateGcode } from './lib/gcode';
import { parseGcode } from './lib/gcodeParse';
import { fmtArea, nozzleToPen, reachableArea } from './lib/machine';
import { heightTest, offsetTest } from './lib/calibration';
import { type Profile, type ProfileStore, loadProfiles, normalizeProfile, saveProfiles } from './lib/profile';
import { buildBoard, penStart } from './lib/pipeline';

type Tab = 'design' | 'calibrate' | 'printer';

/** Traced images start with their long side at this many mm (before placement scaling). */
const IMAGE_MM = 100;

const usePersisted = <T,>(key: string, initial: T) => {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...initial, ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
  }, [key, v]);
  return [v, setV] as const;
};

export default function App() {
  // ---------------------------------------------------------------- profile
  const [store, setStore] = useState<ProfileStore>(() => loadProfiles());
  useEffect(() => saveProfiles(store), [store]);
  const profile = store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0];
  const update = useCallback((patch: Partial<Profile>) => {
    setStore((s) => ({ ...s, profiles: s.profiles.map((p) => (p.id === s.activeId ? normalizeProfile({ ...p, ...patch }) : p)) }));
  }, []);

  const [tab, setTab] = useState<Tab>('design');
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // ---------------------------------------------------------------- sources
  const [sourceState, setSourceRaw] = usePersisted<{ v: SourceKind }>('penplot.source.v1', { v: 'text' });
  const source = sourceState.v;
  const [svg, setSvg] = useState<{ name: string; text: string } | null>(() => {
    try { const raw = localStorage.getItem('penplot.svg.v1'); return raw ? JSON.parse(raw) : null; } catch { return null; }
  });
  useEffect(() => {
    try {
      if (svg && svg.text.length < 1_500_000) localStorage.setItem('penplot.svg.v1', JSON.stringify(svg));
      else localStorage.removeItem('penplot.svg.v1');
    } catch { /* storage full: layout still works for this session */ }
  }, [svg]);
  const [svgTol, setSvgTol] = useState(0.1);
  const [image, setImage] = useState<{ name: string; gray: Gray; file: File; detail: number } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [img, setImgRaw] = usePersisted<ImageSettings>('penplot.img.v1', {
    mode: 'centerline', threshold: 128, invert: false, hatch: false, hatchSpacingMm: 1.5, hatchAngle: 45, detail: 400, simplify: 0.8,
  });
  const [text, setTextRaw] = usePersisted<TextSettings>('penplot.text.v1', { value: 'Pen Plot\ngearup.wtf', size: 12, letterSpacing: 0, lineHeight: 1.7, align: 'center' });
  // ---- board: several copies of the design, persisted
  const [layout, setLayout] = usePersisted<{ instances: Instance[]; selectedId: string | null; lock: boolean }>('penplot.layout.v1', {
    instances: [],
    selectedId: null,
    lock: true,
  });
  const [paper, setPaperRaw] = usePersisted<PaperSettings>('penplot.paper.v1', { preset: 'none', landscape: false, customW: 200, customH: 200, originX: 0, originY: 0 });
  const [grid, setGridRaw] = usePersisted<GridOptions>('penplot.grid.v1', { rows: 2, cols: 2, gapX: 10, gapY: 10, autoFit: true, margin: 10 });
  const [clipboard, setClipboard] = useState<Instance | null>(null);
  const pasteCount = useRef(0);
  const [fitMargin, setFitMargin] = usePersisted<{ v: number }>('penplot.margin.v1', { v: 10 });
  const [opt, setOptRaw] = usePersisted<OptimizeOptions>('penplot.opt.v1', DEFAULT_OPTIMIZE);
  const [boundsMode, setBoundsMode] = useState<'clip' | 'clamp'>('clip');
  // bump to auto-fit the next source geometry (only when the board has 0–1 copies)
  const [fitToken, setFitToken] = useState(() => (layout.instances.length ? 0 : 1));
  const [showTravel, setShowTravel] = useState(true);

  const setImg = (p: Partial<ImageSettings>) => setImgRaw((o) => ({ ...o, ...p }));
  const setText = (p: Partial<TextSettings>) => setTextRaw((o) => ({ ...o, ...p }));
  const setPaper = (p: Partial<PaperSettings>) => setPaperRaw((o) => ({ ...o, ...p }));
  const setGrid = (p: Partial<GridOptions>) => setGridRaw((o) => ({ ...o, ...p }));
  const instances = layout.instances;
  const selected = instances.find((i) => i.id === layout.selectedId) ?? null;
  const setInstances = (fn: (list: Instance[]) => Instance[], selectedId?: string | null) =>
    setLayout((l) => ({ ...l, instances: fn(l.instances), selectedId: selectedId === undefined ? l.selectedId : selectedId }));
  const setInstance = (next: Instance) => setInstances((list) => list.map((i) => (i.id === next.id ? next : i)));
  const select = (id: string | null) => setLayout((l) => ({ ...l, selectedId: id }));
  const setOpt = (p: Partial<OptimizeOptions>) => setOptRaw((o) => ({ ...o, ...p }));
  const setSource = (s: SourceKind) => { setSourceRaw({ v: s }); setFitToken((t) => t + 1); };

  // re-decode the image when the detail setting changes
  const detail = img.detail;
  useEffect(() => {
    if (!image || image.detail === detail) return;
    let live = true;
    loadImageGray(image.file, detail)
      .then((gray) => { if (live) setImage((im) => (im ? { ...im, gray, detail } : im)); })
      .catch(() => {});
    return () => { live = false; };
  }, [detail, image]);

  const onSvgFile = async (f: File) => {
    const t = await f.text();
    setSvg({ name: f.name, text: t });
    setSourceRaw({ v: 'svg' });
    setFitToken((x) => x + 1);
  };
  const onImageFile = async (f: File) => {
    setImageBusy(true);
    setImageError(null);
    try {
      const gray = await loadImageGray(f, img.detail);
      setImage({ name: f.name, gray, file: f, detail: img.detail });
      setSourceRaw({ v: 'image' });
      setFitToken((x) => x + 1);
    } catch {
      setImageError('Could not read that image. Try a PNG or JPG.');
    } finally {
      setImageBusy(false);
    }
  };

  const svgParsed = useMemo(() => (svg ? parseSvg(svg.text, svgTol) : null), [svg, svgTol]);
  const imgD = useDeferredValue(img);
  const scaleD = useDeferredValue(selected?.scale ?? instances[0]?.scale ?? 1);
  const hatchScale = img.hatch && source === 'image' ? scaleD : 1;
  const textD = useDeferredValue(text);
  const sourcePaths: Polyline[] = useMemo(() => {
    if (source === 'svg') return svgParsed ? flipY(svgParsed.paths) : [];
    if (source === 'image') {
      if (!image) return [];
      // mm per pixel chosen so the long side is always IMAGE_MM, whatever the detail setting
      const px = IMAGE_MM / Math.max(image.gray.width, image.gray.height);
      const lines = traceImage(image.gray, {
        mode: imgD.mode, threshold: imgD.threshold, invert: imgD.invert, hatch: imgD.hatch,
        hatchSpacing: imgD.hatchSpacingMm / (px * hatchScale), hatchAngle: imgD.hatchAngle, simplify: imgD.simplify, // spacing is in final bed mm
      });
      return lines.map((l) => l.map((q) => ({ x: q.x * px, y: -q.y * px })));
    }
    return renderText(textD.value, { size: textD.size, letterSpacing: textD.letterSpacing, lineHeight: textD.lineHeight, align: textD.align });
  }, [source, svgParsed, image, imgD, textD, hatchScale]);

  const area = useMemo(() => reachableArea(profile), [profile]);
  const paperBounds = useMemo(() => paperRect(paper), [paper]);
  /** Where fit / grid auto-fit place things: the reachable part of the paper, or the reachable area. */
  const region = useMemo(() => {
    if (!paperBounds) return area;
    const r = intersect(paperBounds, area);
    return r.maxX - r.minX > 5 && r.maxY - r.minY > 5 ? r : area;
  }, [paperBounds, area]);
  const sourceName = source === 'svg' ? svg?.name ?? 'drawing.svg' : source === 'image' ? image?.name ?? 'image' : textSlug(text.value);
  const raw = useMemo(() => { const c = designCenter({ name: '', paths: sourcePaths, x: 0, y: 0, scale: 1, rotation: 0 }); return { w: c.w, h: c.h }; }, [sourcePaths]);

  // auto-fit when a new source arrives (a board with several copies keeps its layout)
  useEffect(() => {
    if (!fitToken || !sourcePaths.length) return;
    setFitToken(0);
    if (layout.instances.length > 1) return;
    const base = layout.instances[0] ?? makeInstance();
    const f = fitInstance({ ...base, scale: 1, scaleY: 1, rotation: 0, mirror: false }, raw, region, fitMargin.v);
    const k = source === 'text' ? Math.min(f.scale, 1) : f.scale; // don't blow text up past its set size
    const inst = { ...f, scale: k, scaleY: k };
    setLayout((l) => ({ ...l, instances: [inst], selectedId: inst.id }));
  }, [fitToken, sourcePaths]);

  // ---- board actions
  const pasteFrom = (src: Instance) => {
    pasteCount.current += 1;
    const d = 8 * pasteCount.current;
    const inst = { ...src, id: newId(), x: src.x + d, y: src.y - d };
    setInstances((list) => [...list, inst], inst.id);
  };
  const actions = {
    copy: () => { if (selected) { setClipboard(selected); pasteCount.current = 0; } },
    paste: () => { if (clipboard) pasteFrom(clipboard); },
    duplicate: () => { if (selected) { setClipboard(selected); pasteCount.current = 0; pasteFrom(selected); } },
    remove: () => {
      if (!selected) return;
      const idx = instances.findIndex((i) => i.id === selected.id);
      const rest = instances.filter((i) => i.id !== selected.id);
      setInstances(() => rest, rest[Math.min(idx, rest.length - 1)]?.id ?? null);
    },
    add: () => {
      const inst = fitInstance(makeInstance(), raw, region, fitMargin.v);
      setInstances((list) => [...list, inst], inst.id);
    },
    nudge: (dx: number, dy: number) => { if (selected) setInstance({ ...selected, x: selected.x + dx, y: selected.y + dy }); },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // desktop shortcuts: Ctrl/Cmd+C/V/D, Delete, arrows
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (tabRef.current !== 'design') return;
      const a = actionsRef.current;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'c') { if (window.getSelection()?.toString()) return; a.copy(); e.preventDefault(); }
      else if (mod && k === 'v') { a.paste(); e.preventDefault(); }
      else if (mod && k === 'd') { a.duplicate(); e.preventDefault(); }
      else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) { a.remove(); e.preventDefault(); }
      else if (!mod && e.key.startsWith('Arrow')) {
        const st = e.shiftKey ? 10 : 1;
        const [dx, dy] = e.key === 'ArrowLeft' ? [-st, 0] : e.key === 'ArrowRight' ? [st, 0] : e.key === 'ArrowUp' ? [0, st] : [0, -st];
        a.nudge(dx, dy);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // pointer interaction on the preview
  const drag = useRef<{ hit: Hit; start: { x: number; y: number }; orig: Instance } | null>(null);
  const onBoardPointer: BoardPointer = (type, pt, pxPerMm) => {
    if (type === 'down') {
      const hit = hitTest(instances, raw, pt, HIT_PX / pxPerMm, layout.selectedId, HANDLE_PX / pxPerMm);
      if (!hit) { drag.current = null; select(null); return; }
      const orig = instances.find((i) => i.id === hit.id)!;
      drag.current = { hit, start: pt, orig };
      if (hit.id !== layout.selectedId) select(hit.id);
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (type === 'move') setInstance(dragInstance(d.orig, raw, d.hit.part, d.start, pt, layout.lock));
    else drag.current = null;
  };

  // ---------------------------------------------------------------- calibration
  const [calib, setCalibRaw] = usePersisted<CalibSettings>('penplot.calib.v1', {
    mode: 'height', startZ: profile.penDownZ + 0.4, step: 0.1, count: 8, size: 10, gap: 5, cy: 110, squareSize: 50, crossArm: 15,
  });
  const setCalib = (p: Partial<CalibSettings>) => setCalibRaw((o) => ({ ...o, ...p }));
  const [picked, setPicked] = useState<number | null>(null);
  const hTest = useMemo(
    () => heightTest({ startZ: calib.startZ, step: calib.step, count: calib.count, size: calib.size, gap: calib.gap, cx: (area.minX + area.maxX) / 2, cy: calib.cy }),
    [calib, area],
  );
  const pickSquare = (i: number) => {
    const sq = hTest.squares.find((s) => s.index === i);
    if (!sq) return;
    setPicked(i);
    const lift = profile.penUpZ - profile.penDownZ;
    update({ penDownZ: sq.z, penUpZ: sq.z + lift, penZCalibrated: true });
  };

  // ---------------------------------------------------------------- job
  const pathsD = useDeferredValue(sourcePaths);
  const instancesD = useDeferredValue(instances);
  const job = useMemo(() => {
    if (tab === 'calibrate') {
      if (calib.mode === 'height') {
        const r = generateGcode(hTest.paths, profile, { title: 'Pen-height test', notes: hTest.notes, minZ: hTest.minZ, boundsMode: 'clip' });
        return { kind: 'height' as const, result: r, ghost: hTest.paths.map((p) => p.pts), opt: null, file: 'penplot-pen-height-test.gcode', perInstance: [] };
      }
      const t = offsetTest(profile, { squareSize: calib.squareSize, crossArm: calib.crossArm });
      const ordered = optimize(t.paths.map((p) => p.pts), { ...DEFAULT_OPTIMIZE, mergeTolerance: 0 }, penStart(profile)).paths;
      const r = generateGcode(ordered.map((pts) => ({ pts })), profile, { title: 'Offset test', notes: t.notes, boundsMode: 'clip' });
      return { kind: 'offset' as const, result: r, ghost: t.paths.map((p) => p.pts), opt: null, file: 'penplot-offset-test.gcode', perInstance: [] };
    }
    const b = buildBoard(sourceName, pathsD, instancesD, profile, opt, { boundsMode });
    return { kind: 'design' as const, result: b.result, ghost: b.placed.flat(), opt: b.opt, file: gcodeFileName(`${gcodeFileName(sourceName).replace(/\.gcode$/, '')}-penplot`), perInstance: b.bounds };
  }, [tab, calib.mode, calib.squareSize, calib.crossArm, hTest, profile, sourceName, pathsD, instancesD, opt, boundsMode]);

  const badIndexes = job.perInstance.map((b, i) => (b.ok ? 0 : i + 1)).filter(Boolean);
  const boundsMessage = badIndexes.length
    ? `${badIndexes.length === 1 ? `Copy ${badIndexes[0]} is` : `Copies ${badIndexes.join(', ')} are`} partly outside the reachable area (${fmtArea(area)}). Those parts will be ${boundsMode === 'clip' ? 'clipped (not drawn)' : 'clamped to the edge'}.`
    : null;
  const badIds = useMemo(() => new Set(instancesD.filter((_, i) => job.perInstance[i] && !job.perInstance[i].ok).map((i) => i.id)), [instancesD, job]);
  const boardOverlay: BoardOverlay | undefined = tab === 'calibrate' ? undefined : { instances, raw, selectedId: layout.selectedId, badIds, paper: paperBounds };

  const moves: PreviewMove[] = useMemo(() => {
    const parsed = parseGcode(job.result.gcode, { x: profile.homeX, y: profile.homeY });
    return parsed.moves.map((m) => ({ kind: m.kind, from: nozzleToPen(m.from, profile), to: nozzleToPen(m.to, profile) }));
  }, [job, profile]);
  // the final park move is not part of the drawing: hide it from the preview
  const drawMoves = useMemo(() => {
    let last = moves.length;
    while (last > 0 && moves[last - 1].kind === 'travel') last--;
    return moves.slice(0, last);
  }, [moves]);

  // ---------------------------------------------------------------- playback
  const [progress, setProgress] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);
  useEffect(() => { setProgress(null); setPlaying(false); }, [drawMoves]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const n = drawMoves.length;
    const perSec = Math.max(20, n / 12); // whole job in ~12 s
    let acc = progress ?? 0;
    if (acc >= n) acc = 0;
    const tick = (t: number) => {
      acc += ((t - last) / 1000) * perSec;
      last = t;
      if (acc >= n) { setProgress(n); setPlaying(false); return; }
      setProgress(Math.floor(acc));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, drawMoves]);

  const [canShare] = useState(() => canShareGcode());
  const [exportNote, setExportNote] = useState<string | null>(null);
  const download = () => {
    const name = downloadGcode(job.result.gcode, job.file);
    setExportNote(`Saved as ${name}`);
  };
  const share = async () => {
    try {
      const ok = await shareGcode(job.result.gcode, job.file);
      if (ok) setExportNote(`Shared ${gcodeFileName(job.file)}`);
    } catch {
      setExportNote('Sharing failed — use Download instead.');
    }
  };
  useEffect(() => setExportNote(null), [job.file]);

  const r = job.result;
  const warnings = [...(job.kind === 'design' && boundsMessage ? [boundsMessage] : []), ...r.warnings.filter((w) => !/outside the reachable/.test(w) || job.kind !== 'design')];
  const lastMove = progress !== null && progress > 0 ? drawMoves[progress - 1] : null;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Gear className="brand-gear" size={40} teeth={12} color="var(--gold)" />
          <div>
            <h1>PEN PLOT</h1>
            <p className="sub">Drawings → pen-plotter G-code</p>
          </div>
        </div>
        <button type="button" className="chip" onClick={() => setTab('printer')} title="Printer profile">{profile.name}</button>
      </header>

      {!profile.penZCalibrated && tab !== 'calibrate' && (
        <div className="banner">
          <b>Pen-down Z isn't calibrated.</b> With no spring, a wrong Z drags or crashes the pen.
          <button type="button" className="btn gold" onClick={() => { setTab('calibrate'); setCalib({ mode: 'height' }); }}>Run pen-height test</button>
        </div>
      )}

      <div className="layout">
        <div className="col-preview">
          <div className="panel preview">
            <span className="rivet tl" /><span className="rivet tr" /><span className="rivet bl" /><span className="rivet br" />
            <div className="preview-head">
              <span className="legend"><i className="lg-draw" /> pen down</span>
              <span className="legend"><i className="lg-travel" /> pen up travel</span>
              <span className="legend"><i className="lg-out" /> unreachable</span>
            </div>
            <BedCanvas
              profile={profile}
              area={area}
              moves={drawMoves}
              progress={progress}
              ghost={job.kind === 'design' && badIndexes.length ? job.ghost : undefined}
              squares={job.kind === 'height' ? hTest.squares : undefined}
              selectedSquare={picked}
              onSquareClick={pickSquare}
              showTravel={showTravel}
              board={boardOverlay}
              onBoardPointer={tab === 'calibrate' ? undefined : onBoardPointer}
            />
            <div className="scrub">
              <button type="button" className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause playback' : 'Play back the plot'}>
                {playing ? '❚❚' : '▶'}
              </button>
              <input
                type="range"
                min={0}
                max={drawMoves.length}
                value={progress ?? drawMoves.length}
                onChange={(e) => { setPlaying(false); setProgress(Number(e.target.value)); }}
                aria-label="Playback position"
              />
              <span className="scrub-n">{progress ?? drawMoves.length}/{drawMoves.length}</span>
            </div>
            <div className="scrub-info">
              {lastMove ? (
                <span>{lastMove.kind === 'travel' ? 'Pen UP · travel' : 'Pen DOWN · drawing'} → X {fmt(lastMove.to.x)} Y {fmt(lastMove.to.y)} (pen tip)</span>
              ) : (
                <span>Coordinates are the pen tip. Front of the printer is at the bottom.</span>
              )}
              <Toggle label="Show travel" checked={showTravel} onChange={setShowTravel} />
            </div>
          </div>

          <div className="panel export">
            <div className="export-stats">
              <div><b>{fmtDuration(r.estSeconds)}</b><span>est. time</span></div>
              <div><b>{r.lineCount.toLocaleString()}</b><span>lines</span></div>
              <div><b>{Math.round(r.drawMm).toLocaleString()}</b><span>mm drawn</span></div>
              <div><b>{Math.round(r.travelMm).toLocaleString()}</b><span>mm pen-up</span></div>
              <div><b>{r.penLifts}</b><span>pen lifts</span></div>
            </div>
            {warnings.map((w) => <p key={w} className="warn">{w}</p>)}
            <div className={canShare ? 'export-btns two' : 'export-btns'}>
              <button type="button" className="btn gold big" onClick={download} disabled={!r.paths}>
                ⬇ Download {job.file}
              </button>
              {canShare && (
                <button type="button" className="btn big share" onClick={share} disabled={!r.paths}>
                  ⇪ Share / Save to Files
                </button>
              )}
            </div>
            {exportNote && <p className="note tiny ok-note">{exportNote}</p>}
            <p className="note tiny hint">
              Phone tip: the file must end in <b>.gcode</b>. If your phone still adds <b>.txt</b>, rename it in the Files app (long-press → Rename) before copying it to the SD card{canShare ? ', or use Share → Save to Files' : ''}.
            </p>
            <p className="note tiny">
              Pen-down Z {fmt(job.kind === 'height' ? r.minZ : profile.penDownZ)}{job.kind === 'height' ? ' (lowest square)' : ''} · pen-up Z {fmt(profile.penUpZ)} · safe Z {fmt(profile.safeZ)} · offset X {fmt(profile.penOffsetX)} Y {fmt(profile.penOffsetY)}. No heat, no extrusion.
            </p>
          </div>
        </div>

        <div className="col-controls">
          <nav className="tabs" aria-label="Sections">
            <Segmented
              label="Section"
              value={tab}
              onChange={setTab}
              options={[{ value: 'design', label: 'Design' }, { value: 'calibrate', label: 'Calibrate' }, { value: 'printer', label: 'Printer' }]}
            />
          </nav>
          <div className="panel controls">
            {tab === 'design' && (
              <DesignPanel
                source={source}
                setSource={setSource}
                svgName={svg?.name ?? null}
                svgTol={svgTol}
                setSvgTol={setSvgTol}
                svgWarnings={svgParsed?.warnings ?? []}
                onSvgFile={onSvgFile}
                imageName={image?.name ?? null}
                imageBusy={imageBusy}
                imageError={imageError}
                img={img}
                setImg={setImg}
                onImageFile={onImageFile}
                text={text}
                setText={setText}
                boardSection={
                  <BoardPanel
                    instances={instances}
                    selected={selected}
                    select={select}
                    raw={raw}
                    setSelected={setInstance}
                    resize={(change) => selected && setInstance(resizeInstance(selected, raw, change, layout.lock))}
                    lock={layout.lock}
                    setLock={(lock) => setLayout((l) => ({ ...l, lock }))}
                    onCopy={actions.copy}
                    onPaste={actions.paste}
                    onDuplicate={actions.duplicate}
                    onDelete={actions.remove}
                    onAdd={actions.add}
                    canPaste={!!clipboard}
                    fitMargin={fitMargin.v}
                    setFitMargin={(v) => setFitMargin({ v })}
                    onFit={() => selected && setInstance(fitInstance(selected, raw, region, fitMargin.v))}
                    onCenter={() => selected && setInstance({ ...selected, x: (region.minX + region.maxX) / 2, y: (region.minY + region.maxY) / 2 })}
                    grid={grid}
                    setGrid={setGrid}
                    onMakeGrid={() => {
                      const template = selected ?? instances[0] ?? makeInstance();
                      const list = gridLayout(template, raw, { ...grid, margin: fitMargin.v }, region);
                      setInstances(() => list, list[0]?.id ?? null);
                    }}
                    paper={paper}
                    setPaper={setPaper}
                    onCenterPaper={() => {
                      const ps = paperSize(paper);
                      if (ps) setPaper({ originX: Math.round(((profile.bedW - ps.w) / 2) * 10) / 10, originY: Math.round(((profile.bedH - ps.h) / 2) * 10) / 10 });
                    }}
                    regionLabel={fmtArea(region)}
                    boundsMode={boundsMode}
                    setBoundsMode={setBoundsMode}
                    boundsMessage={boundsMessage}
                    badIndexes={badIndexes}
                  />
                }
                opt={opt}
                setOpt={setOpt}
                stats={job.opt ?? { pathsBefore: 0, pathsAfter: 0, travelBefore: 0, travelAfter: 0 }}
              />
            )}
            {tab === 'calibrate' && (
              <CalibratePanel
                c={calib}
                setC={setCalib}
                profile={profile}
                squares={hTest.squares}
                selected={picked}
                onPick={pickSquare}
                onSetOffset={(x, y) => update({ penOffsetX: Math.round(x * 1000) / 1000, penOffsetY: Math.round(y * 1000) / 1000 })}
              />
            )}
            {tab === 'printer' && (
              <PrinterPanel
                store={store}
                profile={profile}
                update={update}
                select={(id) => setStore((s) => ({ ...s, activeId: id }))}
                duplicate={() =>
                  setStore((s) => {
                    const id = `custom-${Date.now().toString(36)}`;
                    const copy = normalizeProfile({ ...profile, id, name: `${profile.name} copy` });
                    return { profiles: [...s.profiles, copy], activeId: id };
                  })
                }
                remove={() =>
                  setStore((s) => {
                    if (s.profiles.length < 2 || !confirm(`Delete profile "${profile.name}"?`)) return s;
                    const profiles = s.profiles.filter((p) => p.id !== s.activeId);
                    return { profiles, activeId: profiles[0].id };
                  })
                }
              />
            )}
          </div>
        </div>
      </div>

      <footer>
        <p>
          Runs entirely in your browser — no uploads, no accounts. Pen up, travel, pen down, dwell, draw. Never heats, never extrudes.
        </p>
        <p>
          <a href="https://gearup.wtf" target="_blank" rel="noopener">⚙ gearup.wtf</a> · Pen Plot by Capstiller · Hershey font by Dr. A. V. Hershey (NBS)
        </p>
      </footer>
    </div>
  );
}
