/** Design -> bed paths -> optimised order -> G-code. Shared by the app and the tests. */
import { type Design, placeDesign } from './design';
import { type GcodeOptions, type GcodeResult, generateGcode } from './gcode';
import type { Polyline } from './geometry';
import { type BoundsReport, checkBounds, nozzleToPen } from './machine';
import { type Instance, toDesign } from './board';
import { type OptimizeOptions, type OptimizeResult, optimize } from './optimize';
import type { Profile } from './profile';

export function penStart(prof: Profile) {
  return nozzleToPen({ x: prof.homeX, y: prof.homeY }, prof);
}

export interface PlotBuild {
  placed: Polyline[];
  opt: OptimizeResult;
  result: GcodeResult;
}

export function buildPlot(design: Design, prof: Profile, o: OptimizeOptions, g: GcodeOptions = {}): PlotBuild {
  const placed = placeDesign(design);
  const opt = optimize(placed, o, penStart(prof));
  const result = generateGcode(opt.paths.map((pts) => ({ pts })), prof, { title: design.name, ...g });
  return { placed, opt, result };
}

// ------------------------------------------------------------------ board -----

export interface BoardBuild {
  /** placed paths per instance (pen coords, unclipped) */
  placed: Polyline[][];
  /** bounds report per instance (same order as instances) */
  bounds: BoundsReport[];
  opt: OptimizeResult;
  result: GcodeResult;
}

/**
 * Every instance of the design goes into ONE program. Paths from all instances are optimised
 * together so the pen-up travel stays short; clipping to the reachable area applies to each path.
 */
export function buildBoard(name: string, paths: Polyline[], instances: Instance[], prof: Profile, o: OptimizeOptions, g: GcodeOptions = {}): BoardBuild {
  const placed = instances.map((inst) => placeDesign(toDesign(name, paths, inst)));
  const bounds = placed.map((p) => checkBounds(p, prof));
  const opt = optimize(placed.flat(), o, penStart(prof));
  const out = bounds.map((b, i) => (b.outside ? i + 1 : 0)).filter(Boolean);
  const notes = [
    `Copies on the board: ${instances.length}`,
    ...(out.length ? [`Copies partly out of reach (clipped/clamped): ${out.join(', ')}`] : []),
    ...(g.notes ?? []),
  ];
  const result = generateGcode(opt.paths.map((pts) => ({ pts })), prof, { title: name, ...g, notes });
  return { placed, bounds, opt, result };
}
