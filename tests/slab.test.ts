import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type RunSpec, DEFAULT_OPTICS, DEFAULT_TRACE, capSequence1, cubeSpacing, gridForRuns, gridStats, placeOnBed, readCell,
  runDuration, sampleRun, spotPositions, traceRuns,
} from '../src/lib/slab';
import { DEFAULT_OPTIMIZE, optimize } from '../src/lib/optimize';
import { generateGcode } from '../src/lib/gcode';
import { penStart } from '../src/lib/pipeline';
import { reachableArea } from '../src/lib/machine';
import { assertPenInvariants } from './invariants';
import { prof } from './helpers';

const run = (p: Partial<RunSpec> = {}): RunSpec => ({
  name: 'Cap Sequence 1', steps: capSequence1(), optics: { ...DEFAULT_OPTICS }, multiplier: 1, circleDia: 0, circleRev: 4, spotDia: 1.75, homeDwell: 30, ...p,
});

describe('slab simulator', () => {
  it('cube spacing: 18.8 mm at zero, ~15 mm 10 mm closer', () => {
    expect(cubeSpacing(0)).toBeCloseTo(18.8, 6);
    expect(cubeSpacing(-10)).toBeCloseTo(15.04, 2);
    const s = spotPositions(DEFAULT_OPTICS);
    expect(s.length).toBe(7);
    expect(s[3].x).toBe(0);
  });

  it('Cap Sequence 1 lasts 122 s + home dwell (244 s at 2x) and draws 7 grooves through bright dots', () => {
    const r = run();
    expect(runDuration({ ...r, homeDwell: 0 })).toBe(122);
    expect(runDuration({ ...r, homeDwell: 0, multiplier: 2 })).toBe(244);
    expect(runDuration(r)).toBe(152);
    const g = gridForRuns([r]);
    const st = gridStats(g);
    const centre = readCell(g, 0, 0)!.e;
    expect(centre).toBeGreaterThan(55); // centre spot sits still through both slow rotations
    for (let i = 0; i < 7; i++) {
      const x = (i - 3) * 18.8;
      expect(readCell(g, x, -20)!.e).toBeGreaterThan(1); // groove
      expect(readCell(g, x + 6, -20)!.e).toBe(0);
      expect(readCell(g, x, 0)!.e).toBeGreaterThan(30); // start dot
    }
    console.log('max', st, 'centre', centre, 'dot1', readCell(g, 18.8, 0), 'groove', readCell(g, 18.8, -20), 'arc', readCell(g, 56.4 * Math.cos(0.3), 56.4 * Math.sin(-0.3)));
    const s = sampleRun(r);
    expect(s.n).toBeGreaterThan(1000);
  });

  it('exports pen-safe G-code from the trajectories', () => {
    const p = prof({ penDownZ: 5.3, penUpZ: 8.3, safeZ: 15, penZCalibrated: true });
    const t = traceRuns([run()], DEFAULT_TRACE);
    const a = reachableArea(p);
    const placed = placeOnBed(t.paths, { x: (a.minX + a.maxX) / 2, y: (a.minY + a.maxY) / 2 }, { scale: 1, outline: true, dx: 0, dy: 0 });
    const o = optimize(placed, { ...DEFAULT_OPTIMIZE }, penStart(p));
    const res = generateGcode(o.paths.map((pts) => ({ pts })), p, { title: 'Slab Test A front - Cap Sequence 1', date: new Date('2026-10-08T12:00:00Z') });
    mkdirSync(new URL('../samples/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../samples/slab-cap-seq-1.gcode', import.meta.url), res.gcode);
    console.log('paths', t.paths.length, 'dots', t.dots, 'optimized', o.paths.length, 'lines', res.lineCount, 'warn', res.warnings);
    assertPenInvariants(res.gcode, p);
    expect(t.dots).toBeGreaterThanOrEqual(7);
    expect(res.outsidePoints).toBe(0);
  });
});
