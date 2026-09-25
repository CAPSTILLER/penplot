/** Placing a design on the bed: move, scale, rotate, fit. Design coords are mm, y up. */
import { type Bounds, type Mat, type Polyline, bounds, mul, rotate, scale, transformPaths, translate } from './geometry';

export interface Design {
  name: string;
  /** Source geometry, y up, arbitrary origin */
  paths: Polyline[];
  /** Bed position (pen coordinates) of the design's centre */
  x: number;
  y: number;
  scale: number;
  /** vertical scale when the aspect ratio is unlocked (defaults to `scale`) */
  scaleY?: number;
  /** degrees, counter-clockwise */
  rotation: number;
  mirror?: boolean;
}

export function designCenter(d: Design): { cx: number; cy: number; w: number; h: number } {
  const b = bounds(d.paths);
  if (!b) return { cx: 0, cy: 0, w: 0, h: 0 };
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, w: b.maxX - b.minX, h: b.maxY - b.minY };
}

export function designMatrix(d: Design): Mat {
  const { cx, cy } = designCenter(d);
  let m: Mat = translate(-cx, -cy);
  if (d.mirror) m = mul(scale(-1, 1), m);
  m = mul(scale(d.scale, d.scaleY ?? d.scale), m);
  m = mul(rotate(d.rotation), m);
  return mul(translate(d.x, d.y), m);
}

export function placeDesign(d: Design): Polyline[] {
  return transformPaths(d.paths, designMatrix(d));
}

/** Scale + centre the design so it fits inside `area` with a margin. Keeps rotation. */
export function fitDesign(d: Design, area: Bounds, margin = 5): Design {
  const ratio = (d.scaleY ?? d.scale) / d.scale;
  const unit = placeDesign({ ...d, x: 0, y: 0, scale: 1, scaleY: ratio });
  const b = bounds(unit);
  if (!b) return d;
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const aw = Math.max(1, area.maxX - area.minX - 2 * margin), ah = Math.max(1, area.maxY - area.minY - 2 * margin);
  const s = Math.min(aw / Math.max(w, 1e-6), ah / Math.max(h, 1e-6));
  return { ...d, scale: s, scaleY: s * ratio, x: (area.minX + area.maxX) / 2, y: (area.minY + area.maxY) / 2 };
}

/** Convert SVG-orientation (y down) geometry to design orientation (y up). */
export function flipY(paths: Polyline[]): Polyline[] {
  return paths.map((p) => p.map((q) => ({ x: q.x, y: -q.y })));
}
