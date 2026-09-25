/** Design -> bed paths -> optimised order -> G-code. Shared by the app and the tests. */
import { type Design, placeDesign } from './design';
import { type GcodeOptions, type GcodeResult, generateGcode } from './gcode';
import type { Polyline } from './geometry';
import { nozzleToPen } from './machine';
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
