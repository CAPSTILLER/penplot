/**
 * Minimal, dependency-free SVG -> polyline converter.
 * Works the same in the browser and in Node (tests), so it does not rely on DOMParser.
 * Output coordinates are millimetres in SVG orientation (y grows downward).
 */
import { type Mat, type Polyline, type Pt, IDENTITY, apply, matScale, mul, rotate, scale, translate } from './geometry';

// ---------------------------------------------------------------- XML ------
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src[lt + 1] === '?' ) {
      const e = src.indexOf('?>', lt);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (src[lt + 1] === '!') {
      // DOCTYPE, possibly with an internal subset [...]
      let j = lt + 2, depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = localName(src.slice(lt + 2, e).trim());
      // pop to the matching element (tolerate sloppy markup)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = e < 0 ? n : e + 1;
      continue;
    }
    // start tag: scan to '>' honouring quotes
    let j = lt + 1;
    let quote = '';
    while (j < n) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    let body = src.slice(lt + 1, j);
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const m = /^([^\s/>]+)/.exec(body);
    const node: XmlNode = { name: localName(m ? m[1] : ''), attrs: {}, children: [] };
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = body.slice(m ? m[1].length : 0);
    while ((a = attrRe.exec(rest))) node.attrs[localName(a[1])] = decodeEntities(a[3] ?? a[4] ?? '');
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  return root;
}

function localName(s: string): string {
  if (s.startsWith('xmlns')) return s;
  const c = s.indexOf(':');
  return c >= 0 ? s.slice(c + 1) : s;
}

// ------------------------------------------------------------ lengths ------
const UNIT_MM: Record<string, number> = { '': 25.4 / 96, px: 25.4 / 96, pt: 25.4 / 72, pc: 25.4 / 6, in: 25.4, cm: 10, mm: 1, q: 0.25 };

/** Parse an SVG length to millimetres. Returns null for percentages or garbage. */
export function lengthToMm(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  if (unit === '%') return null;
  const f = UNIT_MM[unit] ?? (unit === 'em' ? (16 * 25.4) / 96 : undefined);
  return f === undefined ? null : parseFloat(m[1]) * f;
}

function num(v: string | undefined, d = 0): number {
  if (v === undefined) return d;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : d;
}

// ---------------------------------------------------------- transforms -----
export function parseTransform(s: string | undefined): Mat {
  let m: Mat = IDENTITY;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let t: RegExpExecArray | null;
  while ((t = re.exec(s))) {
    const a = (t[2].match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? []).map(Number);
    let k: Mat = IDENTITY;
    switch (t[1].toLowerCase()) {
      case 'matrix': if (a.length >= 6) k = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case 'translate': k = translate(a[0] ?? 0, a[1] ?? 0); break;
      case 'scale': k = scale(a[0] ?? 1, a[1] ?? a[0] ?? 1); break;
      case 'rotate':
        k = rotate(a[0] ?? 0);
        if (a.length >= 3) k = mul(translate(a[1], a[2]), mul(k, translate(-a[1], -a[2])));
        break;
      case 'skewx': k = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewy': k = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, k);
  }
  return m;
}

// ------------------------------------------------------------ flattening ---
function flattenCubic(out: Pt[], p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number, depth = 0): void {
  // flatness: max distance of control points from the chord
  const dx = p3.x - p0.x, dy = p3.y - p0.y;
  const len = Math.hypot(dx, dy);
  let d1: number, d2: number;
  if (len < 1e-12) {
    d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    d2 = Math.hypot(p2.x - p0.x, p2.y - p0.y);
  } else {
    d1 = Math.abs((p1.x - p0.x) * dy - (p1.y - p0.y) * dx) / len;
    d2 = Math.abs((p2.x - p0.x) * dy - (p2.y - p0.y) * dx) / len;
  }
  if (depth >= 18 || Math.max(d1, d2) <= tol) {
    out.push(p3);
    return;
  }
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
  const p012 = mid(p01, p12), p123 = mid(p12, p23);
  const m = mid(p012, p123);
  flattenCubic(out, p0, p01, p012, m, tol, depth + 1);
  flattenCubic(out, m, p123, p23, p3, tol, depth + 1);
}

function flattenArc(out: Pt[], p0: Pt, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p: Pt, tol: number): void {
  if (Math.abs(p0.x - p.x) < 1e-12 && Math.abs(p0.y - p.y) < 1e-12) return;
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 1e-12 || ry < 1e-12) { out.push(p); return; }
  const phi = (phiDeg * Math.PI) / 180;
  const cph = Math.cos(phi), sph = Math.sin(phi);
  const dx2 = (p0.x - p.x) / 2, dy2 = (p0.y - p.y) / 2;
  const x1 = cph * dx2 + sph * dy2;
  const y1 = -sph * dx2 + cph * dy2;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num2 / den));
  if (large === sweep) co = -co;
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const cx = cph * cx1 - sph * cy1 + (p0.x + p.x) / 2;
  const cy = sph * cx1 + cph * cy1 + (p0.y + p.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const r = Math.max(rx, ry);
  const stepAng = tol < r ? 2 * Math.acos(1 - tol / r) : Math.PI / 2;
  const n = Math.max(2, Math.min(2000, Math.ceil(Math.abs(dt) / Math.max(stepAng, 1e-4))));
  for (let i = 1; i <= n; i++) {
    if (i === n) { out.push(p); break; }
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push({ x: cph * ex - sph * ey + cx, y: sph * ex + cph * ey + cy });
  }
}

// ------------------------------------------------------------ path data ----
/** Convert SVG path data into polylines (local coordinates). */
export function pathToPolylines(d: string, tol: number): Polyline[] {
  const out: Polyline[] = [];
  let cur: Pt[] | null = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: Pt | null = null; // for S/s and T/t
  let lastCmd = '';
  let i = 0;
  const n = d.length;
  const skip = () => { while (i < n && /[\s,]/.test(d[i])) i++; };
  const numRe = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
  const readNum = (): number | null => {
    skip();
    const m = numRe.exec(d.slice(i, i + 40));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const readFlag = (): boolean | null => {
    skip();
    const c = d[i];
    if (c === '0' || c === '1') { i++; return c === '1'; }
    return null;
  };
  const start = () => {
    if (!cur) { cur = [{ x, y }]; out.push(cur); }
  };
  let cmd = '';
  while (i < n) {
    skip();
    if (i >= n) break;
    if (/[a-zA-Z]/.test(d[i])) { cmd = d[i++]; }
    else if (!cmd) { i++; continue; }
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'Z') {
      if (cur) { const first = cur[0]; const last = cur[cur.length - 1]; if (last.x !== first.x || last.y !== first.y) cur.push({ x: sx, y: sy }); }
      x = sx; y = sy; cur = null; lastCtrl = null; lastCmd = 'Z';
      cmd = '';
      continue;
    }
    const before = i;
    let ok = true;
    switch (C) {
      case 'M': {
        const a = readNum(), b = readNum();
        if (a === null || b === null) { ok = false; break; }
        x = ox + a; y = oy + b; sx = x; sy = y;
        cur = [{ x, y }]; out.push(cur);
        lastCtrl = null;
        break;
      }
      case 'L': case 'H': case 'V': {
        let nx = x, ny = y;
        if (C === 'L') { const a = readNum(), b = readNum(); if (a === null || b === null) { ok = false; break; } nx = ox + a; ny = oy + b; }
        else if (C === 'H') { const a = readNum(); if (a === null) { ok = false; break; } nx = (rel ? x : 0) + a; }
        else { const a = readNum(); if (a === null) { ok = false; break; } ny = (rel ? y : 0) + a; }
        start(); x = nx; y = ny; cur!.push({ x, y }); lastCtrl = null;
        break;
      }
      case 'C': case 'S': {
        let c1: Pt;
        if (C === 'C') {
          const a = readNum(), b = readNum(); if (a === null || b === null) { ok = false; break; }
          c1 = { x: ox + a, y: oy + b };
        } else {
          c1 = lastCtrl && /[CS]/i.test(lastCmd) ? { x: 2 * x - lastCtrl.x, y: 2 * y - lastCtrl.y } : { x, y };
        }
        const a2 = readNum(), b2 = readNum(), a3 = readNum(), b3 = readNum();
        if (a2 === null || b2 === null || a3 === null || b3 === null) { ok = false; break; }
        const c2 = { x: ox + a2, y: oy + b2 }, p = { x: ox + a3, y: oy + b3 };
        start(); flattenCubic(cur!, { x, y }, c1, c2, p, tol);
        x = p.x; y = p.y; lastCtrl = c2;
        break;
      }
      case 'Q': case 'T': {
        let q: Pt;
        if (C === 'Q') {
          const a = readNum(), b = readNum(); if (a === null || b === null) { ok = false; break; }
          q = { x: ox + a, y: oy + b };
        } else {
          q = lastCtrl && /[QT]/i.test(lastCmd) ? { x: 2 * x - lastCtrl.x, y: 2 * y - lastCtrl.y } : { x, y };
        }
        const a3 = readNum(), b3 = readNum(); if (a3 === null || b3 === null) { ok = false; break; }
        const p = { x: ox + a3, y: oy + b3 };
        const c1 = { x: x + (2 / 3) * (q.x - x), y: y + (2 / 3) * (q.y - y) };
        const c2 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) };
        start(); flattenCubic(cur!, { x, y }, c1, c2, p, tol);
        x = p.x; y = p.y; lastCtrl = q;
        break;
      }
      case 'A': {
        const rx = readNum(), ry = readNum(), rot = readNum(), la = readFlag(), sw = readFlag(), a = readNum(), b = readNum();
        if (rx === null || ry === null || rot === null || la === null || sw === null || a === null || b === null) { ok = false; break; }
        const p = { x: ox + a, y: oy + b };
        start(); flattenArc(cur!, { x, y }, rx, ry, rot, la, sw, p, tol);
        x = p.x; y = p.y; lastCtrl = null;
        break;
      }
      default:
        ok = false;
    }
    lastCmd = cmd;
    if (!ok) {
      // malformed data: stop parsing this command, move past the offending char
      if (i === before) i++;
      cmd = '';
    }
  }
  return out.filter((p) => p.length >= 2);
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}Z`;
}

function rectPath(x: number, y: number, w: number, h: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
    `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
}

function pointsList(s: string | undefined): Pt[] {
  const a = (s?.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? []).map(Number);
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < a.length; i += 2) pts.push({ x: a[i], y: a[i + 1] });
  return pts;
}

function styleProp(node: XmlNode, prop: string): string | undefined {
  const st = node.attrs.style;
  if (st) {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(st);
    if (m) return m[1].trim();
  }
  return node.attrs[prop];
}

const SKIP = new Set(['defs', 'clippath', 'mask', 'symbol', 'marker', 'pattern', 'title', 'desc', 'metadata', 'style', 'script', 'lineargradient', 'radialgradient', 'filter', 'foreignobject', 'namedview']);

export interface SvgResult {
  paths: Polyline[];
  /** Document size in mm when known */
  widthMm: number | null;
  heightMm: number | null;
  warnings: string[];
}

/** Parse an SVG document into mm polylines (y down), flattening curves to `tolMm`. */
export function parseSvg(src: string, tolMm = 0.1): SvgResult {
  const doc = parseXml(src);
  const svg = findFirst(doc, 'svg');
  const warnings: string[] = [];
  if (!svg) return { paths: [], widthMm: null, heightMm: null, warnings: ['No <svg> element found.'] };

  const ids = new Map<string, XmlNode>();
  (function collect(nd: XmlNode) {
    if (nd.attrs.id) ids.set(nd.attrs.id, nd);
    nd.children.forEach(collect);
  })(svg);

  const wMm = lengthToMm(svg.attrs.width);
  const hMm = lengthToMm(svg.attrs.height);
  const vb = (svg.attrs.viewBox ?? svg.attrs.viewbox ?? '').trim().split(/[\s,]+/).map(Number);
  let base: Mat = scale(25.4 / 96);
  let docW: number | null = wMm, docH: number | null = hMm;
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    let s: number;
    if (wMm && hMm) s = Math.min(wMm / vb[2], hMm / vb[3]);
    else if (wMm) s = wMm / vb[2];
    else if (hMm) s = hMm / vb[3];
    else s = 25.4 / 96;
    base = mul(scale(s), translate(-vb[0], -vb[1]));
    docW = docW ?? vb[2] * s;
    docH = docH ?? vb[3] * s;
  }

  const paths: Polyline[] = [];
  let unsupported = 0;
  const walk = (nd: XmlNode, m: Mat, depth: number) => {
    if (depth > 64) return;
    const name = nd.name.toLowerCase();
    if (SKIP.has(name)) return;
    if (styleProp(nd, 'display') === 'none' || styleProp(nd, 'visibility') === 'hidden') return;
    const mm = mul(m, parseTransform(nd.attrs.transform));
    const tol = tolMm / matScale(mm);
    const emit = (d: string) => {
      for (const pl of pathToPolylines(d, tol)) paths.push(pl.map((p) => apply(mm, p)));
    };
    const a = nd.attrs;
    switch (name) {
      case 'svg':
        if (depth > 0) {
          // nested <svg>: position by x/y; viewBox scaling ignored except translation
          const inner = mul(mm, translate(num(a.x), num(a.y)));
          nd.children.forEach((c) => walk(c, inner, depth + 1));
        } else nd.children.forEach((c) => walk(c, mm, depth + 1));
        return;
      case 'g': case 'a': case 'switch':
        nd.children.forEach((c) => walk(c, mm, depth + 1));
        return;
      case 'use': {
        const ref = (a.href ?? '').replace(/^#/, '');
        const target = ids.get(ref);
        if (target) {
          const um = mul(mm, translate(num(a.x), num(a.y)));
          if (target.name === 'symbol') target.children.forEach((c) => walk(c, um, depth + 1));
          else walk(target, um, depth + 1);
        }
        return;
      }
      case 'path': if (a.d) emit(a.d); return;
      case 'line': emit(`M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`); return;
      case 'polyline': case 'polygon': {
        const pts = pointsList(a.points);
        if (pts.length < 2) return;
        const d = 'M' + pts.map((p) => `${p.x} ${p.y}`).join('L') + (name === 'polygon' ? 'Z' : '');
        emit(d);
        return;
      }
      case 'rect': {
        const w = num(a.width), h = num(a.height);
        if (w <= 0 || h <= 0) return;
        let rx = a.rx !== undefined ? num(a.rx) : NaN;
        let ry = a.ry !== undefined ? num(a.ry) : NaN;
        if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
        if (Number.isNaN(ry)) ry = rx;
        emit(rectPath(num(a.x), num(a.y), w, h, Math.min(rx, w / 2), Math.min(ry, h / 2)));
        return;
      }
      case 'circle': { const r = num(a.r); if (r > 0) emit(ellipsePath(num(a.cx), num(a.cy), r, r)); return; }
      case 'ellipse': { const rx = num(a.rx), ry = num(a.ry); if (rx > 0 && ry > 0) emit(ellipsePath(num(a.cx), num(a.cy), rx, ry)); return; }
      case 'text': case 'image': case 'tspan':
        unsupported++;
        return;
      default:
        nd.children.forEach((c) => walk(c, mm, depth + 1));
    }
  };
  walk(svg, base, 0);
  if (unsupported) warnings.push(`${unsupported} <text>/<image> element(s) skipped — convert text to paths first, or use the Text tab.`);
  if (!paths.length) warnings.push('No drawable shapes found in this SVG.');
  return { paths, widthMm: docW, heightMm: docH, warnings };
}

function findFirst(nd: XmlNode, name: string): XmlNode | null {
  if (nd.name.toLowerCase() === name) return nd;
  for (const c of nd.children) {
    const f = findFirst(c, name);
    if (f) return f;
  }
  return null;
}
