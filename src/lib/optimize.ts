/** Path clean-up and ordering to minimise pen-up travel. */
import { type Polyline, type Pt, bounds, dist, polylineLength } from './geometry';

export interface OptimizeOptions {
  /** Drop consecutive points closer than this (mm) */
  minSegment: number;
  /** Drop whole paths shorter than this (mm) */
  minPathLength: number;
  /** Join paths whose endpoints are within this distance (mm); 0 disables */
  mergeTolerance: number;
  /** Reorder nearest-neighbour */
  reorder: boolean;
  /** Allow drawing a path backwards when that is closer */
  allowReverse: boolean;
  /** Allow starting a closed loop at whichever vertex is closest */
  rotateLoops: boolean;
}

export const DEFAULT_OPTIMIZE: OptimizeOptions = {
  minSegment: 0.05,
  minPathLength: 0.3,
  mergeTolerance: 0.05,
  reorder: true,
  allowReverse: true,
  rotateLoops: true,
};

export function isClosed(p: Polyline, eps = 1e-6): boolean {
  return p.length > 2 && dist(p[0], p[p.length - 1]) <= eps;
}

/** Total pen-up travel: from `start` to the first path, then between consecutive paths. */
export function travelDistance(paths: Polyline[], start?: Pt): number {
  let d = 0;
  let cur = start ?? (paths[0] ? paths[0][0] : undefined);
  for (const p of paths) {
    if (!p.length) continue;
    if (cur) d += dist(cur, p[0]);
    cur = p[p.length - 1];
  }
  return d;
}

/** Remove tiny segments and tiny paths. */
export function cleanPaths(paths: Polyline[], minSegment: number, minPathLength: number): Polyline[] {
  const out: Polyline[] = [];
  for (const p of paths) {
    if (p.length < 2) continue;
    const q: Pt[] = [p[0]];
    for (let i = 1; i < p.length; i++) {
      const last = i === p.length - 1;
      if (dist(q[q.length - 1], p[i]) >= minSegment) q.push(p[i]);
      else if (last && q.length > 1) q[q.length - 1] = p[i]; // keep the true endpoint (closes loops)
    }
    if (q.length < 2) continue;
    if (polylineLength(q) < minPathLength) continue;
    out.push(q);
  }
  return out;
}

class Grid {
  cell: number;
  map = new Map<number, number[]>();
  constructor(cell: number) { this.cell = Math.max(cell, 1e-3); }
  key(ix: number, iy: number) { return (ix + 32768) * 65536 + (iy + 32768); }
  add(p: Pt, id: number) {
    const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell));
    const a = this.map.get(k);
    if (a) a.push(id); else this.map.set(k, [id]);
  }
  cellOf(p: Pt): [number, number] { return [Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)]; }
}

/** Join paths whose endpoints touch (within tol), reversing pieces when needed. */
export function mergePaths(paths: Polyline[], tol: number): Polyline[] {
  if (tol <= 0 || paths.length < 2) return paths.map((p) => p.slice());
  const n = paths.length;
  const used = new Uint8Array(n);
  const grid = new Grid(Math.max(tol * 4, 0.5));
  // endpoint ids: 2*i = start, 2*i+1 = end
  paths.forEach((p, i) => {
    if (isClosed(p)) return; // closed loops don't chain
    grid.add(p[0], 2 * i);
    grid.add(p[p.length - 1], 2 * i + 1);
  });
  const find = (pt: Pt): number => {
    const [cx, cy] = grid.cellOf(pt);
    let best = -1, bestD = tol;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const ids = grid.map.get(grid.key(cx + dx, cy + dy));
        if (!ids) continue;
        for (const id of ids) {
          const pi = id >> 1;
          if (used[pi]) continue;
          const p = paths[pi];
          const q = id & 1 ? p[p.length - 1] : p[0];
          const d = dist(pt, q);
          if (d <= bestD) { bestD = d; best = id; }
        }
      }
    return best;
  };
  const out: Polyline[] = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = paths[i].slice();
    if (!isClosed(chain)) {
      // extend forward
      for (;;) {
        const id = find(chain[chain.length - 1]);
        if (id < 0) break;
        used[id >> 1] = 1;
        const p = paths[id >> 1];
        const seg = id & 1 ? p.slice().reverse() : p;
        chain = chain.concat(seg.slice(1));
      }
      // extend backward
      for (;;) {
        const id = find(chain[0]);
        if (id < 0) break;
        used[id >> 1] = 1;
        const p = paths[id >> 1];
        const seg = id & 1 ? p : p.slice().reverse();
        chain = seg.slice(0, -1).concat(chain);
      }
    }
    out.push(chain);
  }
  return out;
}

/** Greedy nearest-neighbour ordering using a spatial grid. */
export function orderPaths(paths: Polyline[], start: Pt, allowReverse = true, rotateLoops = true): Polyline[] {
  const n = paths.length;
  if (n < 2 && !rotateLoops) return paths.map((p) => p.slice());
  const b = bounds(paths);
  if (!b) return [];
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
  const grid = new Grid(span / Math.max(1, Math.sqrt(n)));
  // candidates: [pathIndex, vertexIndex, reversed]
  const cand: [number, number, boolean][] = [];
  const addCand = (pt: Pt, pi: number, vi: number, rev: boolean) => { grid.add(pt, cand.length); cand.push([pi, vi, rev]); };
  paths.forEach((p, pi) => {
    if (rotateLoops && isClosed(p)) {
      const step = Math.max(1, Math.floor((p.length - 1) / 200));
      for (let vi = 0; vi < p.length - 1; vi += step) addCand(p[vi], pi, vi, false);
    } else {
      addCand(p[0], pi, 0, false);
      if (allowReverse && p.length > 1) addCand(p[p.length - 1], pi, p.length - 1, true);
    }
  });
  const used = new Uint8Array(n);
  const [gx0, gy0] = grid.cellOf({ x: b.minX, y: b.minY });
  const [gx1, gy1] = grid.cellOf({ x: b.maxX, y: b.maxY });
  const out: Polyline[] = [];
  let cur = start;
  for (let k = 0; k < n; k++) {
    const [cx, cy] = grid.cellOf(cur);
    let best = -1, bestD = Infinity;
    const maxR = Math.max(Math.abs(cx - gx0), Math.abs(cx - gx1), Math.abs(cy - gy0), Math.abs(cy - gy1)) + 1;
    const visit = (ix: number, iy: number) => {
      const key = grid.key(ix, iy);
      const ids = grid.map.get(key);
      if (!ids) return;
      let w = 0;
      for (let j = 0; j < ids.length; j++) {
        const id = ids[j];
        const [pi, vi] = cand[id];
        if (used[pi]) continue; // compact away used candidates as we go
        ids[w++] = id;
        const d = dist(cur, paths[pi][vi]);
        if (d < bestD) { bestD = d; best = id; }
      }
      ids.length = w;
      if (!w) grid.map.delete(key);
    };
    for (let r = 0; r <= maxR; r++) {
      if (r === 0) visit(cx, cy);
      else {
        for (let ix = cx - r; ix <= cx + r; ix++) { visit(ix, cy - r); visit(ix, cy + r); }
        for (let iy = cy - r + 1; iy <= cy + r - 1; iy++) { visit(cx - r, iy); visit(cx + r, iy); }
      }
      if (best >= 0 && bestD <= r * grid.cell) break;
      if (!grid.map.size) break;
    }
    if (best < 0) break;
    const [pi, vi, rev] = cand[best];
    used[pi] = 1;
    const p = paths[pi];
    let q: Polyline;
    if (rev) q = p.slice().reverse();
    else if (vi > 0 && isClosed(p)) q = p.slice(vi, -1).concat(p.slice(0, vi + 1));
    else q = p.slice();
    out.push(q);
    cur = q[q.length - 1];
  }
  return out;
}

export interface OptimizeResult {
  paths: Polyline[];
  travelBefore: number;
  travelAfter: number;
  pathsBefore: number;
  pathsAfter: number;
}

export function optimize(paths: Polyline[], opts: OptimizeOptions, start: Pt): OptimizeResult {
  const travelBefore = travelDistance(paths, start);
  let p = cleanPaths(paths, opts.minSegment, opts.minPathLength);
  if (opts.mergeTolerance > 0) p = mergePaths(p, opts.mergeTolerance);
  if (opts.reorder) p = orderPaths(p, start, opts.allowReverse, opts.rotateLoops);
  return { paths: p, travelBefore, travelAfter: travelDistance(p, start), pathsBefore: paths.length, pathsAfter: p.length };
}
