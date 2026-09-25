import { describe, expect, it } from 'vitest';
import { renderText, textWidth } from '../src/lib/hershey';
import { bounds } from '../src/lib/geometry';
import { hatchMask, traceContours, traceImage, traceSkeleton, thin } from '../src/lib/trace';

describe('Hershey single-stroke text', () => {
  it('draws letters as single strokes at the requested cap height', () => {
    const l = renderText('L', { size: 10 });
    expect(l.length).toBe(2); // vertical + horizontal stroke, not an outline
    const b = bounds(l)!;
    expect(b.maxY - b.minY).toBeCloseTo(10, 6);
    expect(b.minY).toBeCloseTo(0, 6); // sits on the baseline
    expect(renderText('O', { size: 10 }).length).toBe(1);
  });
  it('multi-line text stacks downward', () => {
    const b = bounds(renderText('A\nB', { size: 5, lineHeight: 2 }))!;
    expect(b.minY).toBeCloseTo(-10, 6);
    expect(textWidth('AB', { size: 10 })).toBeGreaterThan(textWidth('A', { size: 10 }));
  });
});

function disk(w: number, h: number, r: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - w / 2, y - h / 2) < r) m[y * w + x] = 1;
  return m;
}

describe('image tracing', () => {
  it('outline traces one closed contour around a disk', () => {
    const c = traceContours(disk(40, 40, 12), 40, 40);
    expect(c.length).toBe(1);
    expect(c[0][0]).toEqual(c[0][c[0].length - 1]);
    const b = bounds(c)!;
    expect(b.maxX - b.minX).toBeGreaterThan(20);
  });
  it('centerline turns a thick bar into roughly one stroke', () => {
    const w = 60, h = 20, m = new Uint8Array(w * h);
    for (let y = 7; y < 13; y++) for (let x = 5; x < 55; x++) m[y * w + x] = 1;
    const lines = traceSkeleton(thin(m, w, h), w, h);
    const longest = Math.max(...lines.map((l) => l.length));
    expect(longest).toBeGreaterThan(35);
  });
  it('hatch fill produces parallel segments inside the shape', () => {
    const lines = hatchMask(disk(40, 40, 12), 40, 40, 3, 0);
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(Math.abs(l[0].y - l[1].y)).toBeLessThan(1e-9);
  });
  it('traceImage end to end on a grayscale buffer', () => {
    const w = 40, h = 40;
    const m = disk(w, h, 12);
    const data = new Uint8ClampedArray(w * h).map((_, i) => (m[i] ? 0 : 255));
    const out = traceImage({ width: w, height: h, data }, { mode: 'outline', threshold: 128, invert: false, hatch: true, hatchSpacing: 4, hatchAngle: 45, simplify: 0.5 });
    expect(out.length).toBeGreaterThan(3);
    const edges = traceImage({ width: w, height: h, data }, { mode: 'edges', threshold: 128, invert: false, hatch: false, hatchSpacing: 4, hatchAngle: 45, simplify: 0.5 });
    expect(edges.length).toBeGreaterThan(0);
  });
});
