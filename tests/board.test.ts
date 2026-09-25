import { describe, expect, it } from 'vitest';
import { dragInstance, fitInstance, gridLayout, hitTest, makeInstance, orientedBox, paperRect, resizeInstance } from '../src/lib/board';
import { buildBoard } from '../src/lib/pipeline';
import { DEFAULT_OPTIMIZE, travelDistance } from '../src/lib/optimize';
import { renderText } from '../src/lib/hershey';
import { parseGcode } from '../src/lib/gcodeParse';
import { nozzleToPen, reachableArea } from '../src/lib/machine';
import type { Polyline } from '../src/lib/geometry';
import { assertPenInvariants } from './invariants';
import { prof } from './helpers';

const square: Polyline[] = [[{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }]];
const raw = { w: 20, h: 10 };

describe('scale inputs', () => {
  const inst = makeInstance({ scale: 2, scaleY: 2 });
  it('width keeps the aspect ratio when locked', () => {
    const r = resizeInstance(inst, raw, { width: 100 }, true);
    expect(r.scale).toBe(5);
    expect(r.scaleY).toBe(5);
    expect((raw.w * r.scale) / (raw.h * r.scaleY)).toBeCloseTo(2, 9);
  });
  it('height keeps the aspect ratio when locked, including a stretched ratio', () => {
    const stretched = { ...inst, scale: 2, scaleY: 3 };
    const r = resizeInstance(stretched, raw, { height: 60 }, true);
    expect(r.scaleY).toBe(6);
    expect(r.scale).toBe(4);
    expect(r.scaleY / r.scale).toBeCloseTo(1.5, 9);
  });
  it('unlocked edits change one axis only; percent resets both', () => {
    const r = resizeInstance(inst, raw, { width: 100 }, false);
    expect(r.scale).toBe(5);
    expect(r.scaleY).toBe(2);
    const p = resizeInstance(r, raw, { percent: 150 }, false);
    expect(p.scale).toBe(1.5);
    expect(p.scaleY).toBe(1.5);
  });
  it('corner drag scales about the centre, keeping aspect when locked', () => {
    const i = makeInstance({ x: 100, y: 100, scale: 1 });
    const d = dragInstance(i, raw, 'scale', { x: 110, y: 105 }, { x: 120, y: 110 }, true);
    expect(d.scale).toBeCloseTo(2, 9);
    expect(d.scaleY).toBeCloseTo(2, 9);
    const u = dragInstance(i, raw, 'scale', { x: 110, y: 105 }, { x: 130, y: 105 }, false);
    expect(u.scale).toBeCloseTo(3, 9);
    expect(u.scaleY).toBeCloseTo(1, 9);
  });
  it('rotate handle and move drag', () => {
    const i = makeInstance({ x: 100, y: 100 });
    expect(dragInstance(i, raw, 'rotate', { x: 100, y: 120 }, { x: 80, y: 100 }, true).rotation).toBeCloseTo(90, 6);
    const m = dragInstance(i, raw, 'move', { x: 5, y: 5 }, { x: 15, y: -5 }, true);
    expect([m.x, m.y]).toEqual([110, 90]);
  });
  it('hit test finds handles of the selection first, then the top-most body', () => {
    const a = makeInstance({ id: 'a', x: 50, y: 50 });
    const b = makeInstance({ id: 'b', x: 55, y: 50 });
    expect(hitTest([a, b], raw, { x: 52, y: 50 }, 3, null, 8)?.id).toBe('b');
    expect(hitTest([a, b], raw, { x: 40, y: 55 }, 3, 'a', 8)).toEqual({ id: 'a', part: 'scale', corner: 0 });
    expect(hitTest([a, b], raw, { x: 50, y: 63 }, 3, 'a', 8)?.part).toBe('rotate');
    expect(hitTest([a, b], raw, { x: 150, y: 150 }, 3, 'a', 8)).toBeNull();
  });
  it('fit keeps the aspect ratio and fits the rotated box', () => {
    const f = fitInstance(makeInstance({ rotation: 90 }), raw, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 0);
    expect(f.scale).toBeCloseTo(5, 9);
    const b = orientedBox(f, raw).aabb;
    expect(b.maxY - b.minY).toBeCloseTo(100, 6);
  });
});

describe('grid / repeat', () => {
  const region = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
  it('produces rows x cols copies at the right positions', () => {
    const g = gridLayout(makeInstance({ scale: 2 }), raw, { rows: 2, cols: 3, gapX: 10, gapY: 5, autoFit: false, margin: 0 }, region);
    expect(g.length).toBe(6);
    // copy is 40 x 20; total width 3*40 + 2*10 = 140 -> x = 50, 100, 150; total height 2*20 + 5 = 45 -> y = 112.5, 87.5
    expect(g.map((i) => i.x)).toEqual([50, 100, 150, 50, 100, 150]);
    expect(g.map((i) => i.y)).toEqual([112.5, 112.5, 112.5, 87.5, 87.5, 87.5]);
    expect(new Set(g.map((i) => i.id)).size).toBe(6);
    g.forEach((i) => expect(i.scale).toBe(2));
  });
  it('auto-fit scales the copies to fill the region minus margin and gaps', () => {
    const g = gridLayout(makeInstance(), raw, { rows: 4, cols: 2, gapX: 10, gapY: 10, autoFit: true, margin: 5 }, region);
    expect(g.length).toBe(8);
    // width limit: (200-10-10)/(2*20)=4.5 ; height limit: (200-10-30)/(4*10)=4
    expect(g[0].scale).toBeCloseTo(4, 9);
    const boxes = g.map((i) => orientedBox(i, raw).aabb);
    const minY = Math.min(...boxes.map((b) => b.minY)), maxY = Math.max(...boxes.map((b) => b.maxY));
    expect(minY).toBeCloseTo(5, 6);
    expect(maxY).toBeCloseTo(195, 6);
    // no overlaps
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        expect(a.maxX <= b.minX + 1e-9 || b.maxX <= a.minX + 1e-9 || a.maxY <= b.minY + 1e-9 || b.maxY <= a.minY + 1e-9).toBe(true);
      }
  });
  it('paper presets and landscape', () => {
    expect(paperRect({ preset: 'a4', landscape: false, customW: 0, customH: 0, originX: 5, originY: 6 })).toEqual({ minX: 5, minY: 6, maxX: 215, maxY: 303 });
    expect(paperRect({ preset: 'letter', landscape: true, customW: 0, customH: 0, originX: 0, originY: 0 })!.maxX).toBeCloseTo(279.4);
    expect(paperRect({ preset: 'none', landscape: false, customW: 0, customH: 0, originX: 0, originY: 0 })).toBeNull();
  });
});

describe('multi-instance G-code', () => {
  const p = prof({ penOffsetX: -25, penOffsetY: 8, penDownZ: 4.6, penUpZ: 7.6, penZCalibrated: true });
  const text = renderText('Hi', { size: 10 });
  const grid = gridLayout(makeInstance({ scale: 1.5 }), { w: 14, h: 10 }, { rows: 3, cols: 3, gapX: 8, gapY: 8, autoFit: false, margin: 0 }, reachableArea(p));

  it('one file, all copies, lift before every travel, no E, Z floor', () => {
    const b = buildBoard('hi', text, grid, p, DEFAULT_OPTIMIZE);
    expect(b.placed.length).toBe(9);
    const { travels, parsed } = assertPenInvariants(b.result.gcode, p);
    expect(travels).toBe(b.result.paths);
    expect(b.result.paths).toBe(b.opt.pathsAfter);
    expect(parsed.eMoves).toBe(0);
    expect(b.result.gcode).toContain('; Copies on the board: 9');
    // every copy's strokes are drawn: total drawn length = 9 x one copy
    const one = buildBoard('hi', text, [grid[0]], p, DEFAULT_OPTIMIZE).result.drawMm;
    expect(b.result.drawMm).toBeCloseTo(9 * one, 3);
  });

  it('optimises across copies (travel shorter than drawing copy-by-copy)', () => {
    const b = buildBoard('hi', text, grid, p, DEFAULT_OPTIMIZE);
    const naive = b.placed.flat();
    expect(b.opt.travelAfter).toBeLessThan(travelDistance(naive, nozzleToPen({ x: p.homeX, y: p.homeY }, p)));
  });

  it('clips and warns per instance when a copy is out of reach', () => {
    const inst = [makeInstance({ x: 100, y: 100 }), makeInstance({ x: 205, y: 100, scale: 3 })];
    const b = buildBoard('sq', square, inst, p, DEFAULT_OPTIMIZE);
    expect(b.bounds[0].ok).toBe(true);
    expect(b.bounds[1].ok).toBe(false);
    expect(b.result.gcode).toContain('Copies partly out of reach (clipped/clamped): 2');
    assertPenInvariants(b.result.gcode, p);
    const a = reachableArea(p);
    for (const m of parseGcode(b.result.gcode, { x: p.homeX, y: p.homeY }).moves.filter((m) => m.kind === 'draw'))
      expect(nozzleToPen(m.to, p).x).toBeLessThanOrEqual(a.maxX + 1e-9);
  });
});
