/** Single-stroke text using the Hershey Roman Simplex font. Output is mm, y up (bed orientation). */
import type { Polyline } from './geometry';
import { HERSHEY_SIMPLEX } from './hersheyData';

const R = 'R'.charCodeAt(0);
/** Hershey simplex capitals span y = -12 .. 9 (21 units); baseline is y = 9. */
const CAP_UNITS = 21;
const BASELINE = 9;

interface Glyph {
  left: number;
  right: number;
  strokes: [number, number][][];
}

const cache = new Map<number, Glyph>();
function glyph(code: number): Glyph {
  const idx = code >= 32 && code <= 126 ? code - 32 : '?'.charCodeAt(0) - 32;
  let g = cache.get(idx);
  if (g) return g;
  const s = HERSHEY_SIMPLEX[idx];
  const strokes: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (let i = 2; i + 1 < s.length; i += 2) {
    if (s[i] === ' ' && s[i + 1] === 'R') {
      if (cur.length) strokes.push(cur);
      cur = [];
      continue;
    }
    cur.push([s.charCodeAt(i) - R, s.charCodeAt(i + 1) - R]);
  }
  if (cur.length) strokes.push(cur);
  g = { left: s.charCodeAt(0) - R, right: s.charCodeAt(1) - R, strokes };
  cache.set(idx, g);
  return g;
}

export interface TextOptions {
  /** Capital letter height in mm */
  size: number;
  /** Extra space between letters in mm */
  letterSpacing?: number;
  /** Line pitch as a multiple of cap height */
  lineHeight?: number;
  align?: 'left' | 'center' | 'right';
}

export function textWidth(line: string, opts: TextOptions): number {
  const s = opts.size / CAP_UNITS;
  let w = 0;
  for (const ch of line) {
    const g = glyph(ch.codePointAt(0)!);
    w += (g.right - g.left) * s + (opts.letterSpacing ?? 0);
  }
  return Math.max(0, w - (line.length ? opts.letterSpacing ?? 0 : 0));
}

/** Render text as single-stroke polylines. First line's baseline sits on y = 0. */
export function renderText(text: string, opts: TextOptions): Polyline[] {
  const s = opts.size / CAP_UNITS;
  const pitch = opts.size * (opts.lineHeight ?? 1.6);
  const lines = text.replace(/\r/g, '').split('\n');
  const widths = lines.map((l) => textWidth(l, opts));
  const maxW = Math.max(0, ...widths);
  const out: Polyline[] = [];
  lines.forEach((line, li) => {
    let x = opts.align === 'center' ? (maxW - widths[li]) / 2 : opts.align === 'right' ? maxW - widths[li] : 0;
    const baseY = -li * pitch;
    for (const ch of line) {
      const g = glyph(ch.codePointAt(0)!);
      for (const st of g.strokes) {
        if (st.length < 2) continue;
        out.push(st.map(([gx, gy]) => ({ x: x + (gx - g.left) * s, y: baseY - (gy - BASELINE) * s })));
      }
      x += (g.right - g.left) * s + (opts.letterSpacing ?? 0);
    }
  });
  return out;
}
