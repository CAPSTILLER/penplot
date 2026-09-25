import { describe, expect, it } from 'vitest';
import { checkBounds, nozzleToPen, penToNozzle, reachableArea } from '../src/lib/machine';
import { generateGcode } from '../src/lib/gcode';
import { parseGcode } from '../src/lib/gcodeParse';
import { clipPolylines } from '../src/lib/clip';
import { prof } from './helpers';

describe('pen offset math', () => {
  const p = prof({ penOffsetX: -32.5, penOffsetY: 12 });
  it('nozzle = pen - offset and round-trips', () => {
    expect(penToNozzle({ x: 100, y: 100 }, p)).toEqual({ x: 132.5, y: 88 });
    expect(nozzleToPen(penToNozzle({ x: 7, y: 9 }, p), p)).toEqual({ x: 7, y: 9 });
  });
  it('G-code puts the pen tip where the preview shows it', () => {
    const r = generateGcode([{ pts: [{ x: 50, y: 60 }, { x: 80, y: 60 }] }], p);
    const moves = parseGcode(r.gcode, { x: p.homeX, y: p.homeY }).moves;
    const draw = moves.find((m) => m.kind === 'draw')!;
    expect(nozzleToPen(draw.from, p)).toEqual({ x: 50, y: 60 });
    expect(nozzleToPen(draw.to, p)).toEqual({ x: 80, y: 60 });
    expect(draw.from).toEqual({ x: 82.5, y: 48 });
  });
  it('reachable area is nozzle limits shifted by the offset, intersected with the bed', () => {
    expect(reachableArea(p)).toEqual({ minX: 0, maxX: 187.5, minY: 12, maxY: 220 });
    expect(reachableArea(prof({ penOffsetX: 20, penOffsetY: -5 }))).toEqual({ minX: 20, maxX: 220, minY: 0, maxY: 215 });
  });
});

describe('bed bounds', () => {
  const p = prof({ penOffsetX: -40, penOffsetY: 0 });
  it('warns about points outside the reachable area', () => {
    const r = checkBounds([[{ x: 10, y: 10 }, { x: 200, y: 10 }, { x: 170, y: 50 }]], p);
    expect(r.ok).toBe(false);
    expect(r.outside).toBe(1);
    expect(r.message).toMatch(/outside the reachable area/);
    expect(checkBounds([[{ x: 10, y: 10 }, { x: 170, y: 10 }]], p).ok).toBe(true);
  });
  it('clips (default) or clamps so no nozzle move exceeds machine limits', () => {
    const paths = [{ pts: [{ x: 100, y: 100 }, { x: 250, y: 100 }, { x: 100, y: 150 }] }];
    for (const boundsMode of ['clip', 'clamp'] as const) {
      const r = generateGcode(paths, p, { boundsMode });
      expect(r.outsidePoints).toBe(1);
      expect(r.warnings.join(' ')).toMatch(boundsMode === 'clip' ? /clipped/ : /clamped/);
      for (const m of parseGcode(r.gcode, { x: p.homeX, y: p.homeY }).moves) {
        for (const q of [m.from, m.to]) {
          expect(q.x).toBeLessThanOrEqual(p.xMax + 1e-9);
          expect(q.x).toBeGreaterThanOrEqual(p.xMin - 1e-9);
          expect(nozzleToPen(q, p).x).toBeLessThanOrEqual(180 + 1e-9);
        }
      }
    }
  });
  it('clipping splits a line that leaves and re-enters', () => {
    const out = clipPolylines([[{ x: 0, y: 5 }, { x: 20, y: 5 }, { x: 20, y: 6 }, { x: 0, y: 6 }]], { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(out.length).toBe(2);
    expect(out[0][1]).toEqual({ x: 10, y: 5 });
    expect(out[1][0]).toEqual({ x: 10, y: 6 });
  });
});
