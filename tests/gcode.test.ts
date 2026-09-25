import { describe, expect, it } from 'vitest';
import { generateGcode, sanitizeUserGcode } from '../src/lib/gcode';
import { parseCommands } from '../src/lib/gcodeParse';
import { heightTest } from '../src/lib/calibration';
import { assertPenInvariants } from './invariants';
import { prof } from './helpers';

const square = (x: number, y: number, s: number) => [
  { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x, y },
];

describe('generateGcode', () => {
  const p = prof({ penDownZ: 4.2, penUpZ: 7.2, safeZ: 12, penOffsetX: -30, penOffsetY: 10 });
  const paths = [
    { pts: square(60, 60, 20) },
    { pts: [{ x: 100, y: 100 }, { x: 150, y: 120 }, { x: 140, y: 160 }] },
    { pts: square(120, 40, 10) },
  ];
  const res = generateGcode(paths, p, { title: 'unit', date: new Date(0) });

  it('lifts before every travel and lowers + dwells after it', () => {
    const { travels } = assertPenInvariants(res.gcode, p);
    expect(travels).toBe(3);
    expect(res.penLifts).toBe(2);
  });

  it('never extrudes and never heats (only S0)', () => {
    expect(res.gcode).not.toMatch(/\bE-?\d/);
    expect(res.gcode).not.toMatch(/M109|M190/);
    const heat = parseCommands(res.gcode).filter((c) => /^M(104|140)$/.test(c.word));
    expect(heat.length).toBe(2);
    heat.forEach((c) => expect(c.params.S).toBe(0));
  });

  it('never goes below pen-down Z', () => {
    const zs = parseCommands(res.gcode).filter((c) => 'Z' in c.params && /^G[01]$/.test(c.word)).map((c) => c.params.Z);
    expect(Math.min(...zs)).toBeCloseTo(4.2, 6);
  });

  it('first move after G28 is the safe Z lift', () => {
    const cmds = parseCommands(res.gcode);
    const h = cmds.findIndex((c) => c.word === 'G28');
    const next = cmds[h + 1];
    expect(next.word).toBe('G0');
    expect(next.params.Z).toBe(12);
    expect('X' in next.params).toBe(false);
  });

  it('has a header with settings, time and an exact line count', () => {
    expect(res.gcode).toMatch(/; Pen-down Z 4\.2/);
    expect(res.gcode).toMatch(/; Estimated time: /);
    const m = /; Lines: (\d+)/.exec(res.gcode)!;
    expect(Number(m[1])).toBe(res.gcode.trimEnd().split('\n').length);
    expect(Number(m[1])).toBe(res.lineCount);
  });

  it('uses G4 P<ms> dwells from the profile', () => {
    expect(res.gcode).toContain(`G4 P${p.dwellDownMs}`);
    expect(res.gcode).toContain(`G4 P${p.dwellUpMs}`);
  });

  it('holds the invariants with corner dwell and corner slow-down', () => {
    for (const cornerMode of ['dwell', 'slow'] as const) {
      const pc = prof({ ...p, cornerMode, cornerAngle: 45 });
      const r = generateGcode(paths, pc);
      assertPenInvariants(r.gcode, pc);
      if (cornerMode === 'dwell') expect(r.gcode).toContain(`G4 P${pc.cornerDwellMs} ; corner`);
      else expect(r.gcode).toContain(`F${(pc.drawSpeed * pc.cornerSlowPct) / 100}`);
    }
  });

  it('sanitises unsafe user start/end G-code', () => {
    const w: string[] = [];
    const out = sanitizeUserGcode('M104 S210\nM190 S60\nG1 E5 F300\nG1 Z0.2\nG28', 3, w, 'Start');
    expect(out[0]).toMatch(/^; \[removed/);
    expect(out[1]).toMatch(/^; \[removed/);
    expect(out[2]).toMatch(/^; \[removed/);
    expect(out[3]).toMatch(/^G1 Z3 /);
    expect(out[4]).toBe('G28');
    expect(w.length).toBe(4);
    const bad = prof({ ...p, startGcode: 'G28\nM109 S200\nG1 Z0 E3' });
    assertPenInvariants(generateGcode(paths, bad).gcode, bad);
  });

  it('calibration squares step Z down and note each value; floor is the lowest square', () => {
    const t = heightTest({ startZ: 6, step: 0.1, count: 8, size: 8, gap: 4, cx: 110, cy: 110 });
    expect(t.squares.map((s) => s.z)).toEqual([6, 5.9, 5.8, 5.7, 5.6, 5.5, 5.4, 5.3]);
    const pc = prof({ ...p, penDownZ: 6, penUpZ: 9 });
    const r = generateGcode(t.paths, pc, { notes: t.notes, minZ: t.minZ });
    expect(r.gcode).toContain('Square 8: pen-down Z 5.3');
    assertPenInvariants(r.gcode, pc, t.minZ);
    const downs = parseCommands(r.gcode).filter((c) => /; pen down$/.test(c.raw)).map((c) => c.params.Z);
    expect(downs).toEqual([6, 5.9, 5.8, 5.7, 5.6, 5.5, 5.4, 5.3]);
  });
});
