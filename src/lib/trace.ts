/**
 * Raster -> line art. Pure functions on grayscale buffers so they run in tests too.
 * Output polylines are in pixel coordinates (y down).
 */
import { type Polyline, type Pt, simplify } from './geometry';

export interface Gray {
  width: number;
  height: number;
  /** 0 = black .. 255 = white */
  data: Uint8ClampedArray | Uint8Array;
}

export type TraceMode = 'outline' | 'centerline' | 'edges';

export interface TraceOptions {
  mode: TraceMode;
  /** 0..255. Dark-pixel cut-off (outline/centerline) or edge strength (edges). */
  threshold: number;
  invert: boolean;
  hatch: boolean;
  /** hatch line spacing in pixels */
  hatchSpacing: number;
  hatchAngle: number;
  /** RDP simplification in pixels */
  simplify: number;
}

/** RGBA (canvas ImageData) -> grayscale, compositing transparency over white. */
export function toGray(rgba: { width: number; height: number; data: Uint8ClampedArray }): Gray {
  const { width, height, data } = rgba;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const a = data[j + 3] / 255;
    const l = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    out[i] = l * a + 255 * (1 - a);
  }
  return { width, height, data: out };
}

export function thresholdMask(g: Gray, t: number, invert = false): Uint8Array {
  const m = new Uint8Array(g.width * g.height);
  for (let i = 0; i < m.length; i++) m[i] = (g.data[i] < t) !== invert ? 1 : 0;
  return m;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; c++; } }
      tmp[y * w + x] = s / c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c++; } }
      out[y * w + x] = s / c;
    }
  }
  return out;
}

/** Sobel edge magnitude, normalised to 0..255. */
export function edgeMagnitude(g: Gray): Float32Array {
  const { width: w, height: h } = g;
  let f: Float32Array = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = g.data[i];
  f = boxBlur(f, w, h, 1);
  const mag = new Float32Array(w * h);
  let max = 1e-6;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -f[i - w - 1] - 2 * f[i - 1] - f[i + w - 1] + f[i - w + 1] + 2 * f[i + 1] + f[i + w + 1];
      const gy = -f[i - w - 1] - 2 * f[i - w] - f[i - w + 1] + f[i + w - 1] + 2 * f[i + w] + f[i + w + 1];
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      if (m > max) max = m;
    }
  for (let i = 0; i < mag.length; i++) mag[i] = (mag[i] / max) * 255;
  return mag;
}

/** Zhang–Suen thinning (in place). */
export function thin(m: Uint8Array, w: number, h: number): Uint8Array {
  const del: number[] = [];
  let changed = true;
  const P = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? m[y * w + x] : 0);
  let iter = 0;
  while (changed && iter++ < 200) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) continue;
          const p2 = P(x, y - 1), p3 = P(x + 1, y - 1), p4 = P(x + 1, y), p5 = P(x + 1, y + 1);
          const p6 = P(x, y + 1), p7 = P(x - 1, y + 1), p8 = P(x - 1, y), p9 = P(x - 1, y - 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
          if (A !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(y * w + x);
        }
      if (del.length) changed = true;
      for (const i of del) m[i] = 0;
    }
  }
  return m;
}

/** Trace a 1-px skeleton into polylines (pixel centres). */
export function traceSkeleton(m: Uint8Array, w: number, h: number): Polyline[] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  // neighbours: orthogonal always; diagonal only when not bridged by an orthogonal pixel
  const nbrs = (i: number): number[] => {
    const x = i % w, y = (i - x) / w;
    const r: number[] = [];
    const o = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of o) if (on(x + dx, y + dy)) r.push((y + dy) * w + x + dx);
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]])
      if (on(x + dx, y + dy) && !on(x + dx, y) && !on(x, y + dy)) r.push((y + dy) * w + x + dx);
    return r;
  };
  const visited = new Set<number>();
  const ek = (a: number, b: number) => (a < b ? a * w * h + b : b * w * h + a);
  const pt = (i: number): Pt => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 });
  const out: Polyline[] = [];
  const walk = (s: number, n: number) => {
    const line = [pt(s)];
    let prev = s, cur = n;
    visited.add(ek(s, n));
    for (;;) {
      line.push(pt(cur));
      const nb = nbrs(cur);
      if (nb.length !== 2) break; // endpoint or junction
      const next = nb[0] === prev ? nb[1] : nb[0];
      const k = ek(cur, next);
      if (visited.has(k)) break;
      visited.add(k);
      prev = cur; cur = next;
    }
    out.push(line);
  };
  const deg = new Map<number, number>();
  for (let i = 0; i < w * h; i++) if (m[i]) deg.set(i, nbrs(i).length);
  // start from endpoints and junctions
  for (const [i, d] of deg) {
    if (d === 2) continue;
    if (d === 0) { out.push([pt(i), { x: pt(i).x + 0.5, y: pt(i).y }]); continue; }
    for (const n of nbrs(i)) if (!visited.has(ek(i, n))) walk(i, n);
  }
  // remaining pure loops
  for (const [i] of deg) for (const n of nbrs(i)) if (!visited.has(ek(i, n))) walk(i, n);
  return out;
}

/** Marching squares boundaries of the mask (closed contours around dark regions). */
export function traceContours(m: Uint8Array, w: number, h: number): Polyline[] {
  const W = w + 2, H = h + 2; // pad so every contour closes
  const v = (x: number, y: number) => (x >= 1 && y >= 1 && x <= w && y <= h ? m[(y - 1) * w + (x - 1)] : 0);
  // segments between edge midpoints, keyed on doubled integer coordinates
  const next = new Map<number, number>();
  const key = (x2: number, y2: number) => y2 * (2 * W + 2) + x2;
  const add = (ax: number, ay: number, bx: number, by: number) => next.set(key(ax, ay), key(bx, by));
  for (let y = 0; y < H - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const tl = v(x, y), tr = v(x + 1, y), br = v(x + 1, y + 1), bl = v(x, y + 1);
      const c = tl * 8 + tr * 4 + br * 2 + bl;
      if (c === 0 || c === 15) continue;
      // midpoints (doubled): top, right, bottom, left
      const T: [number, number] = [2 * x + 1, 2 * y], Rr: [number, number] = [2 * x + 2, 2 * y + 1];
      const B: [number, number] = [2 * x + 1, 2 * y + 2], L: [number, number] = [2 * x, 2 * y + 1];
      const seg = (a: [number, number], b: [number, number]) => add(a[0], a[1], b[0], b[1]);
      // orientation keeps the filled region on the right-hand side
      switch (c) {
        case 1: seg(L, B); break;
        case 2: seg(B, Rr); break;
        case 3: seg(L, Rr); break;
        case 4: seg(Rr, T); break;
        case 5: seg(L, T); seg(Rr, B); break;
        case 6: seg(B, T); break;
        case 7: seg(L, T); break;
        case 8: seg(T, L); break;
        case 9: seg(T, B); break;
        case 10: seg(T, Rr); seg(B, L); break;
        case 11: seg(T, Rr); break;
        case 12: seg(Rr, L); break;
        case 13: seg(Rr, B); break;
        case 14: seg(B, L); break;
      }
    }
  const out: Polyline[] = [];
  const stride = 2 * W + 2;
  const toPt = (k: number): Pt => ({ x: (k % stride) / 2 - 0.5, y: Math.floor(k / stride) / 2 - 0.5 });
  for (const startKey of Array.from(next.keys())) {
    if (!next.has(startKey)) continue;
    const line: Pt[] = [toPt(startKey)];
    let k = startKey;
    for (let guard = 0; guard < 4 * W * H; guard++) {
      const n = next.get(k);
      if (n === undefined) break;
      next.delete(k);
      line.push(toPt(n));
      k = n;
      if (k === startKey) break;
    }
    if (line.length > 2) out.push(line);
  }
  return out;
}

/** Parallel hatch lines clipped to the mask. */
export function hatchMask(m: Uint8Array, w: number, h: number, spacing: number, angleDeg: number): Polyline[] {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a); // along the hatch line
  const nx = -dy, ny = dx; // across
  const cx = w / 2, cy = h / 2;
  const R = Math.hypot(w, h) / 2 + 1;
  const out: Polyline[] = [];
  const sp = Math.max(1, spacing);
  let flip = false;
  for (let o = -R; o <= R; o += sp) {
    const segs: Polyline[] = [];
    let run: Pt | null = null;
    let last: Pt | null = null;
    for (let t = -R; t <= R; t += 0.5) {
      const x = cx + nx * o + dx * t, y = cy + ny * o + dy * t;
      const xi = Math.floor(x), yi = Math.floor(y);
      const inside = xi >= 0 && yi >= 0 && xi < w && yi < h && m[yi * w + xi] === 1;
      if (inside) { if (!run) run = { x, y }; last = { x, y }; }
      else if (run && last) { segs.push([run, last]); run = null; }
    }
    if (run && last) segs.push([run, last]);
    const ok = segs.filter((s) => Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y) >= 1);
    if (flip) { ok.reverse(); ok.forEach((s) => s.reverse()); }
    flip = !flip;
    out.push(...ok);
  }
  return out;
}

export function traceImage(g: Gray, o: TraceOptions): Polyline[] {
  const { width: w, height: h } = g;
  let lines: Polyline[] = [];
  let fillMask: Uint8Array;
  if (o.mode === 'edges') {
    const mag = edgeMagnitude(g);
    const m = new Uint8Array(w * h);
    // slider: higher threshold = only stronger edges. Map 0..255 to 255..0 edge cut.
    const cut = 255 - o.threshold;
    for (let i = 0; i < m.length; i++) m[i] = mag[i] >= Math.max(4, cut) ? 1 : 0;
    lines = traceSkeleton(thin(m, w, h), w, h);
    fillMask = thresholdMask(g, 128, o.invert);
  } else {
    const m = thresholdMask(g, o.threshold, o.invert);
    fillMask = m.slice();
    lines = o.mode === 'outline' ? traceContours(m, w, h) : traceSkeleton(thin(m, w, h), w, h);
  }
  lines = lines.map((l) => simplify(l, o.simplify)).filter((l) => l.length >= 2);
  if (o.hatch) lines.push(...hatchMask(fillMask, w, h, o.hatchSpacing, o.hatchAngle));
  return lines;
}
