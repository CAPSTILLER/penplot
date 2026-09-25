import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIMIZE, cleanPaths, mergePaths, optimize, orderPaths, travelDistance } from '../src/lib/optimize';
import type { Polyline } from '../src/lib/geometry';

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('path optimisation', () => {
  it('nearest-neighbour ordering reduces travel a lot on shuffled short strokes', () => {
    const r = rng(42);
    const paths: Polyline[] = [];
    for (let i = 0; i < 400; i++) {
      const x = r() * 200, y = r() * 200;
      paths.push([{ x, y }, { x: x + 2, y: y + 1 }]);
    }
    const start = { x: 220, y: 220 };
    const before = travelDistance(paths, start);
    const res = optimize(paths, { ...DEFAULT_OPTIMIZE, mergeTolerance: 0 }, start);
    expect(res.paths.length).toBe(400);
    expect(res.travelAfter).toBeLessThan(before * 0.3);
  });

  it('reverses a path when its far end is closer', () => {
    const a: Polyline = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const b: Polyline = [{ x: 50, y: 0 }, { x: 11, y: 0 }];
    const out = orderPaths([a, b], { x: 0, y: 0 }, true, false);
    expect(out[1][0]).toEqual({ x: 11, y: 0 });
    const noRev = orderPaths([a, b], { x: 0, y: 0 }, false, false);
    expect(noRev[1][0]).toEqual({ x: 50, y: 0 });
    expect(travelDistance(out, { x: 0, y: 0 })).toBeLessThan(travelDistance(noRev, { x: 0, y: 0 }));
  });

  it('starts a closed loop at its nearest vertex', () => {
    const loop: Polyline = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
    const [o] = orderPaths([loop], { x: 11, y: 11 }, true, true);
    expect(o[0]).toEqual({ x: 10, y: 10 });
    expect(o[o.length - 1]).toEqual({ x: 10, y: 10 });
    expect(o.length).toBe(5);
  });

  it('merges paths whose endpoints touch, reversing pieces as needed', () => {
    const merged = mergePaths(
      [
        [{ x: 0, y: 0 }, { x: 1, y: 0 }],
        [{ x: 2, y: 0 }, { x: 1, y: 0 }],
        [{ x: 2, y: 0 }, { x: 3, y: 0 }],
        [{ x: 9, y: 9 }, { x: 8, y: 8 }],
      ],
      0.01,
    );
    expect(merged.length).toBe(2);
    expect(merged[0]).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
  });

  it('drops tiny segments and tiny paths but keeps real endpoints', () => {
    const out = cleanPaths(
      [
        [{ x: 0, y: 0 }, { x: 0.01, y: 0 }, { x: 5, y: 0 }, { x: 5.01, y: 0 }],
        [{ x: 1, y: 1 }, { x: 1.05, y: 1 }],
      ],
      0.1,
      0.3,
    );
    expect(out.length).toBe(1);
    expect(out[0]).toEqual([{ x: 0, y: 0 }, { x: 5.01, y: 0 }]);
  });
});
