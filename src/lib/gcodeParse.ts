/** Parse G-code back into moves — used for the preview and to sanity-check exports. */
import type { Pt } from './geometry';

export type MoveKind = 'draw' | 'travel';

export interface Move {
  kind: MoveKind;
  /** nozzle coordinates */
  from: Pt;
  to: Pt;
  z: number;
  /** index of the source line */
  line: number;
}

export interface Cmd {
  line: number;
  word: string;
  params: Record<string, number>;
  raw: string;
}

export interface ParsedGcode {
  cmds: Cmd[];
  moves: Move[];
  minZ: number;
  maxZ: number;
  eMoves: number;
  heaterCmds: string[];
}

export function parseCommands(src: string): Cmd[] {
  const out: Cmd[] = [];
  src.split('\n').forEach((raw, line) => {
    const code = raw.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim().toUpperCase();
    if (!code) return;
    const parts = code.match(/[A-Z][+-]?[\d.]*/g) ?? [];
    if (!parts.length) return;
    const w = parts[0]!;
    const word = w[0] + String(parseInt(w.slice(1) || '0', 10));
    const params: Record<string, number> = {};
    for (const p of parts.slice(1)) {
      const v = parseFloat(p.slice(1));
      params[p[0]] = Number.isFinite(v) ? v : NaN;
    }
    out.push({ line, word, params, raw });
  });
  return out;
}

/**
 * Walks the program tracking absolute position. G0 = travel, G1/G2/G3 with XY = draw.
 * Starts at `home` (position after G28).
 */
export function parseGcode(src: string, home: Pt = { x: 0, y: 0 }): ParsedGcode {
  const cmds = parseCommands(src);
  const moves: Move[] = [];
  let x = home.x, y = home.y, z = 0;
  let minZ = Infinity, maxZ = -Infinity, eMoves = 0;
  let absolute = true;
  const heaterCmds: string[] = [];
  for (const c of cmds) {
    switch (c.word) {
      case 'G90': absolute = true; break;
      case 'G91': absolute = false; break;
      case 'G28': x = home.x; y = home.y; z = 0; break;
      case 'G0': case 'G1': case 'G2': case 'G3': {
        if ('E' in c.params) eMoves++;
        const nx = 'X' in c.params ? (absolute ? c.params.X : x + c.params.X) : x;
        const ny = 'Y' in c.params ? (absolute ? c.params.Y : y + c.params.Y) : y;
        const nz = 'Z' in c.params ? (absolute ? c.params.Z : z + c.params.Z) : z;
        if ('Z' in c.params) { minZ = Math.min(minZ, nz); maxZ = Math.max(maxZ, nz); }
        if (nx !== x || ny !== y) {
          moves.push({ kind: c.word === 'G0' ? 'travel' : 'draw', from: { x, y }, to: { x: nx, y: ny }, z: nz, line: c.line });
        }
        x = nx; y = ny; z = nz;
        break;
      }
      default:
        if (/^M(104|109|140|190|141|191)$/.test(c.word)) heaterCmds.push(c.raw.trim());
    }
  }
  return { cmds, moves, minZ, maxZ, eMoves, heaterCmds };
}
