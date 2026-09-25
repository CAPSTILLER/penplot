import { describe, expect, it } from 'vitest';
import { lengthToMm, parseSvg, parseTransform, pathToPolylines } from '../src/lib/svg';
import { bounds, polylineLength } from '../src/lib/geometry';

const wrap = (inner: string, attrs = 'width="100mm" height="100mm" viewBox="0 0 100 100"') =>
  `<?xml version="1.0"?><!-- test --><svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe('SVG parsing', () => {
  it('rect -> closed 4-sided loop in mm', () => {
    const r = parseSvg(wrap('<rect x="10" y="20" width="30" height="40"/>'));
    expect(r.paths.length).toBe(1);
    const p = r.paths[0];
    expect(p.length).toBe(5);
    expect(p[0]).toEqual(p[4]);
    expect(bounds(r.paths)).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 60 });
    expect(r.widthMm).toBe(100);
  });

  it('line, polyline, polygon', () => {
    const r = parseSvg(wrap('<line x1="0" y1="0" x2="10" y2="0"/><polyline points="0,10 10,10 10,20"/><polygon points="20 20 30 20 25 30"/>'));
    expect(r.paths.length).toBe(3);
    expect(r.paths[0]).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(r.paths[1].length).toBe(3);
    expect(r.paths[2].length).toBe(4);
    expect(r.paths[2][3]).toEqual({ x: 20, y: 20 });
  });

  it('circle and ellipse are flattened within tolerance', () => {
    const tol = 0.05;
    const r = parseSvg(wrap('<circle cx="50" cy="50" r="20"/><ellipse cx="50" cy="50" rx="30" ry="10"/>'), tol);
    expect(r.paths.length).toBe(2);
    for (const q of r.paths[0]) expect(Math.abs(Math.hypot(q.x - 50, q.y - 50) - 20)).toBeLessThan(1e-6);
    expect(polylineLength(r.paths[0])).toBeGreaterThan(2 * Math.PI * 20 - 0.5);
    expect(polylineLength(r.paths[0])).toBeLessThanOrEqual(2 * Math.PI * 20);
    const b = bounds([r.paths[1]])!;
    expect(b.maxX - b.minX).toBeCloseTo(60, 3);
    expect(b.maxY - b.minY).toBeCloseTo(20, 1);
  });

  it('respects nested transforms and viewBox scaling', () => {
    const r = parseSvg(
      wrap('<g transform="translate(10,10)"><g transform="scale(2)"><rect width="10" height="5"/></g></g>', 'width="50mm" height="50mm" viewBox="0 0 100 100"'),
    );
    // user units are 0.5 mm; rect spans (10..30, 10..20) user units -> (5..15, 5..10) mm
    expect(bounds(r.paths)).toEqual({ minX: 5, minY: 5, maxX: 15, maxY: 10 });
  });

  it('rotate transform with centre', () => {
    const m = parseTransform('rotate(90 10 10)');
    const x = m[0] * 20 + m[2] * 10 + m[4];
    const y = m[1] * 20 + m[3] * 10 + m[5];
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(20, 9);
  });

  it('path commands incl. relative, H/V, curves, arcs and packed numbers', () => {
    const p = pathToPolylines('m10 10h10v10H10z M0 0c10 0 10 10 20 10 s10-10 20-10 Q50 10 60 0 t20 0 a5 5 0 0110 0 L1.5.5', 0.1);
    expect(p[0]).toEqual([{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 10 }]);
    const last = p[1][p[1].length - 1];
    expect(last).toEqual({ x: 1.5, y: 0.5 });
    // arc end point reached exactly
    expect(p[1].some((q) => Math.abs(q.x - 90) < 1e-9 && Math.abs(q.y) < 1e-9)).toBe(true);
  });

  it('skips defs / hidden elements, follows <use>, warns on text', () => {
    const r = parseSvg(
      wrap('<defs><rect id="r" width="5" height="5"/></defs><use href="#r" x="50" y="50"/><rect width="9" height="9" style="display:none"/><text>hi</text>'),
    );
    expect(r.paths.length).toBe(1);
    expect(bounds(r.paths)).toEqual({ minX: 50, minY: 50, maxX: 55, maxY: 55 });
    expect(r.warnings.join(' ')).toMatch(/text/);
  });

  it('units', () => {
    expect(lengthToMm('1in')).toBeCloseTo(25.4);
    expect(lengthToMm('96')).toBeCloseTo(25.4);
    expect(lengthToMm('2cm')).toBe(20);
    expect(lengthToMm('50%')).toBeNull();
  });
});
