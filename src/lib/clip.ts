/** Clip polylines to an axis-aligned rectangle (Liang–Barsky), splitting where they leave it. */
import type { Bounds, Polyline, Pt } from './geometry';

function clipSeg(a: Pt, b: Pt, r: Bounds): [Pt, Pt] | null {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.minX, r.maxX - a.x, a.y - r.minY, r.maxY - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
}

export function clipPolylines(paths: Polyline[], r: Bounds): Polyline[] {
  const out: Polyline[] = [];
  const eq = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
  for (const p of paths) {
    let cur: Polyline | null = null;
    for (let i = 1; i < p.length; i++) {
      const c = clipSeg(p[i - 1], p[i], r);
      if (!c) { cur = null; continue; }
      if (cur && eq(cur[cur.length - 1], c[0])) cur.push(c[1]);
      else { cur = [c[0], c[1]]; out.push(cur); }
      if (!eq(c[1], p[i])) cur = null; // left the rectangle mid-segment
    }
  }
  return out.filter((p) => p.length >= 2 && !(p.length === 2 && eq(p[0], p[1])));
}
