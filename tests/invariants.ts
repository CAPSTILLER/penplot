import { expect } from 'vitest';
import { parseCommands, parseGcode } from '../src/lib/gcodeParse';
import type { Profile } from '../src/lib/profile';

/** Asserts every pen-plotter safety rule on a generated program. */
export function assertPenInvariants(gcode: string, p: Profile, floorZ = p.penDownZ) {
  const cmds = parseCommands(gcode);
  let z = 0;
  let travels = 0;
  let homed = false;
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    if (c.word === 'G28') { homed = true; z = 0; continue; }
    if (!/^G[0-3]$/.test(c.word)) continue;
    expect('E' in c.params, `E move on line ${c.line + 1}: ${c.raw}`).toBe(false);
    if ('Z' in c.params) {
      expect(c.params.Z, `Z below pen-down on line ${c.line + 1}`).toBeGreaterThanOrEqual(floorZ - 1e-9);
      z = c.params.Z;
    }
    const xy = 'X' in c.params || 'Y' in c.params;
    if (!xy) continue;
    expect(homed, 'XY move before homing').toBe(true);
    if (c.word === 'G0') {
      const moreDrawing = cmds.slice(i + 1).some((k) => k.word === 'G1' && ('X' in k.params || 'Y' in k.params));
      if (!moreDrawing) {
        // final park move: pen must be up
        expect(z).toBeGreaterThanOrEqual(p.penUpZ - 1e-9);
        continue;
      }
      travels++;
      // preceded by pen-up Z
      expect(z, `travel at pen-down height on line ${c.line + 1}`).toBeGreaterThanOrEqual(p.penUpZ - 1e-9);
      // the command before the travel is either the pen-up dwell or the safe-Z lift
      const prev = cmds[i - 1];
      const okPrev = (prev.word === 'G4' && cmds[i - 2].word === 'G0' && 'Z' in cmds[i - 2].params) || (prev.word === 'G0' && 'Z' in prev.params && !('X' in prev.params));
      expect(okPrev, `travel on line ${c.line + 1} not preceded by pen up`).toBe(true);
      // followed by pen-down Z and a dwell
      const n1 = cmds[i + 1], n2 = cmds[i + 2];
      expect(n1.word === 'G1' && 'Z' in n1.params && !('X' in n1.params), `travel on line ${c.line + 1} not followed by pen-down`).toBe(true);
      expect(n1.params.Z).toBeLessThan(p.penUpZ);
      expect(n2.word, `pen-down after line ${c.line + 1} not followed by dwell`).toBe('G4');
      expect('P' in n2.params).toBe(true);
    } else {
      // drawing happens only with the pen down
      expect(z, `draw move with pen up on line ${c.line + 1}`).toBeLessThan(p.penUpZ);
    }
  }
  const parsed = parseGcode(gcode, { x: p.homeX, y: p.homeY });
  expect(parsed.eMoves).toBe(0);
  for (const h of parsed.heaterCmds) expect(h).toMatch(/^M(104|140)\s+S0\b/i);
  expect(parsed.minZ).toBeGreaterThanOrEqual(floorZ - 1e-9);
  return { travels, parsed };
}
