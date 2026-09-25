import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Gear } from './components/Gear';
import { BedCanvas, type PreviewMove } from './components/BedCanvas';
import { Segmented, Toggle } from './components/Fields';
import { DesignPanel, type ImageSettings, type Placement, type SourceKind, type TextSettings } from './panels/DesignPanel';
import { CalibratePanel, type CalibSettings } from './panels/CalibratePanel';
import { PrinterPanel } from './panels/PrinterPanel';
import { type Design, designCenter, fitDesign, flipY, placeDesign } from './lib/design';
import type { Polyline } from './lib/geometry';
import { parseSvg } from './lib/svg';
import { renderText } from './lib/hershey';
import { type Gray, traceImage } from './lib/trace';
import { loadImageGray } from './lib/image';
import { DEFAULT_OPTIMIZE, type OptimizeOptions, optimize } from './lib/optimize';
import { type PlotPath, fmt, fmtDuration, generateGcode } from './lib/gcode';
import { parseGcode } from './lib/gcodeParse';
import { checkBounds, nozzleToPen, reachableArea } from './lib/machine';
import { heightTest, offsetTest } from './lib/calibration';
import { type Profile, type ProfileStore, loadProfiles, normalizeProfile, saveProfiles } from './lib/profile';
import { penStart } from './lib/pipeline';

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

  // ---------------------------------------------------------------- sources
  const [source, setSourceRaw] = useState<SourceKind>('text');
  const [svg, setSvg] = useState<{ name: string; text: string } | null>(null);
  const [svgTol, setSvgTol] = useState(0.1);
  const [image, setImage] = useState<{ name: string; gray: Gray; file: File; detail: number } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [img, setImgRaw] = usePersisted<ImageSettings>('penplot.img.v1', {
    mode: 'centerline', threshold: 128, invert: false, hatch: false, hatchSpacingMm: 1.5, hatchAngle: 45, detail: 400, simplify: 0.8,
  });
  const [text, setTextRaw] = usePersisted<TextSettings>('penplot.text.v1', { value: 'Pen Plot\ngearup.wtf', size: 12, letterSpacing: 0, lineHeight: 1.7, align: 'center' });
  const [placement, setPlacementRaw] = useState<Placement>({ x: 110, y: 110, scale: 1, rotation: 0, mirror: false });
  const [fitMargin, setFitMargin] = usePersisted<{ v: number }>('penplot.margin.v1', { v: 10 });
  const [opt, setOptRaw] = usePersisted<OptimizeOptions>('penplot.opt.v1', DEFAULT_OPTIMIZE);
  const [boundsMode, setBoundsMode] = useState<'clip' | 'clamp'>('clip');
  const [fitToken, setFitToken] = useState(1); // bump to auto-fit the next source geometry
  const [showTravel, setShowTravel] = useState(true);

  const setImg = (p: Partial<ImageSettings>) => setImgRaw((o) => ({ ...o, ...p }));
  const setText = (p: Partial<TextSettings>) => setTextRaw((o) => ({ ...o, ...p }));
  const setPlacement = (p: Partial<Placement>) => setPlacementRaw((o) => ({ ...o, ...p }));
  const setOpt = (p: Partial<OptimizeOptions>) => setOptRaw((o) => ({ ...o, ...p }));
  const setSource = (s: SourceKind) => { setSourceRaw(s); setFitToken((t) => t + 1); };

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
    setSourceRaw('svg');
    setFitToken((x) => x + 1);
  };
  const onImageFile = async (f: File) => {
    setImageBusy(true);
    setImageError(null);
    try {
      const gray = await loadImageGray(f, img.detail);
      setImage({ name: f.name, gray, file: f, detail: img.detail });
      setSourceRaw('image');
      setFitToken((x) => x + 1);
    } catch {
      setImageError('Could not read that image. Try a PNG or JPG.');
    } finally {
      setImageBusy(false);
    }
  };

  const svgParsed = useMemo(() => (svg ? parseSvg(svg.text, svgTol) : null), [svg, svgTol]);
  const imgD = useDeferredValue(img);
  const scaleD = useDeferredValue(placement.scale);
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
  const sourceName = source === 'svg' ? svg?.name ?? 'drawing.svg' : source === 'image' ? image?.name ?? 'image' : 'text';

  // auto-fit when a new source arrives
  useEffect(() => {
    if (!fitToken || !sourcePaths.length) return;
    const d: Design = { name: sourceName, paths: sourcePaths, ...placement, rotation: 0, mirror: false };
    const f = fitDesign(d, area, fitMargin.v);
    const s = source === 'text' ? Math.min(f.scale, 1) : f.scale; // don't blow text up past its set size
    setPlacementRaw({ x: f.x, y: f.y, scale: s, rotation: 0, mirror: false });
    setFitToken(0);
  }, [fitToken, sourcePaths]);

  const design: Design = useMemo(() => ({ name: sourceName, paths: sourcePaths, ...placement }), [sourceName, sourcePaths, placement]);
  const designD = useDeferredValue(design);
  const size = useMemo(() => designCenter({ ...design, scale: 1 }), [design]);

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
  const job = useMemo(() => {
    if (tab === 'calibrate') {
      if (calib.mode === 'height') {
        const r = generateGcode(hTest.paths, profile, { title: 'Pen-height test', notes: hTest.notes, minZ: hTest.minZ, boundsMode: 'clip' });
        return { kind: 'height' as const, result: r, ghost: hTest.paths.map((p) => p.pts), opt: null, file: 'penplot-pen-height-test.gcode' };
      }
      const t = offsetTest(profile, { squareSize: calib.squareSize, crossArm: calib.crossArm });
      const ordered = optimize(t.paths.map((p) => p.pts), { ...DEFAULT_OPTIMIZE, mergeTolerance: 0 }, penStart(profile)).paths;
      const r = generateGcode(ordered.map((pts) => ({ pts })), profile, { title: 'Offset test', notes: t.notes, boundsMode: 'clip' });
      return { kind: 'offset' as const, result: r, ghost: t.paths.map((p) => p.pts), opt: null, file: 'penplot-offset-test.gcode' };
    }
    const placed = placeDesign(designD);
    const o = optimize(placed, opt, penStart(profile));
    const r = generateGcode(o.paths.map((pts): PlotPath => ({ pts })), profile, { title: designD.name, boundsMode });
    const base = designD.name.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'drawing';
    return { kind: 'design' as const, result: r, ghost: placed, opt: o, file: `${base}-penplot.gcode` };
  }, [tab, calib.mode, calib.squareSize, calib.crossArm, hTest, profile, designD, opt, boundsMode]);

  const bounds = useMemo(() => checkBounds(job.ghost, profile), [job, profile]);

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

  const download = () => {
    const blob = new Blob([job.result.gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = job.file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const r = job.result;
  const warnings = [...(job.kind === 'design' && bounds.message ? [bounds.message] : []), ...r.warnings.filter((w) => !/outside the reachable/.test(w) || job.kind !== 'design')];
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
              ghost={job.kind === 'design' && !bounds.ok ? job.ghost : undefined}
              squares={job.kind === 'height' ? hTest.squares : undefined}
              selectedSquare={picked}
              onSquareClick={pickSquare}
              showTravel={showTravel}
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
            <button type="button" className="btn gold big" onClick={download} disabled={!r.paths}>
              ⬇ Download {job.file}
            </button>
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
                placement={placement}
                setPlacement={setPlacement}
                size={{ w: size.w, h: size.h }}
                fitMargin={fitMargin.v}
                setFitMargin={(v) => setFitMargin({ v })}
                onFit={() => {
                  const f = fitDesign(design, area, fitMargin.v);
                  setPlacement({ x: f.x, y: f.y, scale: f.scale });
                }}
                onCenter={() => setPlacement({ x: (area.minX + area.maxX) / 2, y: (area.minY + area.maxY) / 2 })}
                opt={opt}
                setOpt={setOpt}
                stats={job.opt ?? { pathsBefore: 0, pathsAfter: 0, travelBefore: 0, travelAfter: 0 }}
                boundsMode={boundsMode}
                setBoundsMode={setBoundsMode}
                boundsMessage={bounds.message}
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
