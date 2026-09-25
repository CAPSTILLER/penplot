/** Pen offset math and bed-bounds checks. */
import type { Bounds, Polyline, Pt } from './geometry';
import type { Profile } from './profile';

/** Nozzle position that puts the pen tip on `p`. */
export function penToNozzle(p: Pt, prof: Pick<Profile, 'penOffsetX' | 'penOffsetY'>): Pt {
  return { x: p.x - prof.penOffsetX, y: p.y - prof.penOffsetY };
}

/** Where the pen tip is when the nozzle is at `n`. */
export function nozzleToPen(n: Pt, prof: Pick<Profile, 'penOffsetX' | 'penOffsetY'>): Pt {
  return { x: n.x + prof.penOffsetX, y: n.y + prof.penOffsetY };
}

/**
 * The area the pen tip can actually reach AND that lies on the bed.
 * Nozzle limits shifted by the pen offset, intersected with the bed rectangle.
 */
export function reachableArea(prof: Profile): Bounds {
  return {
    minX: Math.max(0, prof.xMin + prof.penOffsetX),
    maxX: Math.min(prof.bedW, prof.xMax + prof.penOffsetX),
    minY: Math.max(0, prof.yMin + prof.penOffsetY),
    maxY: Math.min(prof.bedH, prof.yMax + prof.penOffsetY),
  };
}

export function inArea(p: Pt, a: Bounds, eps = 1e-6): boolean {
  return p.x >= a.minX - eps && p.x <= a.maxX + eps && p.y >= a.minY - eps && p.y <= a.maxY + eps;
}

export function clampToArea(p: Pt, a: Bounds): Pt {
  return { x: Math.min(a.maxX, Math.max(a.minX, p.x)), y: Math.min(a.maxY, Math.max(a.minY, p.y)) };
}

export interface BoundsReport {
  total: number;
  outside: number;
  area: Bounds;
  ok: boolean;
  message: string | null;
}

/** Count design points (pen coordinates) that fall outside the reachable area. */
export function checkBounds(paths: Polyline[], prof: Profile): BoundsReport {
  const area = reachableArea(prof);
  let total = 0, outside = 0;
  for (const p of paths) for (const q of p) { total++; if (!inArea(q, area)) outside++; }
  const empty = area.maxX <= area.minX || area.maxY <= area.minY;
  const message = empty
    ? 'The pen offset leaves no reachable area on the bed — check the offset values.'
    : outside
      ? `${outside} of ${total} points fall outside the reachable area (${fmtArea(area)}) once the pen offset is applied. They will be clamped to the edge.`
      : null;
  return { total, outside, area, ok: !outside && !empty, message };
}

export function fmtArea(a: Bounds): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  return `X ${r(a.minX)}–${r(a.maxX)}, Y ${r(a.minY)}–${r(a.maxY)} mm`;
}
