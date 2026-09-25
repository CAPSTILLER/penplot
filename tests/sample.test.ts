import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSvg } from '../src/lib/svg';
import { fitDesign, flipY, placeDesign, type Design } from '../src/lib/design';
import { DEFAULT_OPTIMIZE } from '../src/lib/optimize';
import { buildPlot } from '../src/lib/pipeline';
import { reachableArea, nozzleToPen } from '../src/lib/machine';
import { bounds, polylineLength } from '../src/lib/geometry';
import { assertPenInvariants } from './invariants';
import { prof } from './helpers';

describe('sample G-code from a test SVG, parsed back', () => {
  const svg = readFileSync(new URL('./fixtures/sample.svg', import.meta.url), 'utf8');
  const p = prof({ penOffsetX: -28, penOffsetY: 6, penDownZ: 5.3, penUpZ: 8.3, safeZ: 15, penZCalibrated: true });
  const parsed = parseSvg(svg, 0.1);
  let design: Design = { name: 'sample.svg', paths: flipY(parsed.paths), x: 0, y: 0, scale: 1, rotation: 0 };
  design = fitDesign(design, reachableArea(p), 10);
  const build = buildPlot(design, p, DEFAULT_OPTIMIZE, { date: new Date('2026-09-25T12:00:00Z') });
  mkdirSync(new URL('../samples/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../samples/sample.gcode', import.meta.url), build.result.gcode);

  it('parses every shape in the SVG', () => {
    expect(parsed.warnings).toEqual([]);
    expect(parsed.paths.length).toBe(13);
  });

  it('obeys all pen invariants', () => {
    const { travels, parsed: g } = assertPenInvariants(build.result.gcode, p);
    expect(travels).toBe(build.result.paths);
    expect(g.eMoves).toBe(0);
  });

  it('pen-tip path read back from the G-code matches the placed design', () => {
    const g = assertPenInvariants(build.result.gcode, p).parsed;
    const draws = g.moves.filter((m) => m.kind === 'draw');
    const penPts = draws.flatMap((m) => [nozzleToPen(m.from, p), nozzleToPen(m.to, p)]);
    const gb = bounds([penPts])!;
    const db = bounds(placeDesign(design))!;
    expect(gb.minX).toBeCloseTo(db.minX, 2);
    expect(gb.maxX).toBeCloseTo(db.maxX, 2);
    expect(gb.minY).toBeCloseTo(db.minY, 2);
    expect(gb.maxY).toBeCloseTo(db.maxY, 2);
    const drawn = draws.reduce((s, m) => s + Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y), 0);
    const designLen = placeDesign(design).reduce((s, pl) => s + polylineLength(pl), 0);
    expect(Math.abs(drawn - designLen) / designLen).toBeLessThan(0.01);
    // stays inside the reachable area
    const a = reachableArea(p);
    expect(gb.minX).toBeGreaterThanOrEqual(a.minX);
    expect(gb.maxX).toBeLessThanOrEqual(a.maxX);
  });

  it('optimisation reduced pen-up travel', () => {
    expect(build.opt.travelAfter).toBeLessThan(build.opt.travelBefore);
  });
});
