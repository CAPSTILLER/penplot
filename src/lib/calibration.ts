/** Calibration drawings: pen-height squares and the offset crosshair. */
import type { Polyline } from './geometry';
import { renderText } from './hershey';
import type { PlotPath } from './gcode';
import type { Profile } from './profile';
import { fmt } from './gcode';

export interface HeightTestOptions {
  /** Z of square 1 (least pressure). Each next square is `step` lower (closer to the pen). */
  startZ: number;
  step: number;
  count: number;
  size: number;
  gap: number;
  /** centre of the row (pen coordinates) */
  cx: number;
  cy: number;
}

export interface HeightSquare {
  index: number;
  z: number;
  x: number;
  y: number;
  size: number;
}

export function heightTestSquares(o: HeightTestOptions): HeightSquare[] {
  const n = Math.max(1, Math.min(20, Math.round(o.count)));
  const total = n * o.size + (n - 1) * o.gap;
  const x0 = o.cx - total / 2;
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    z: Math.round((o.startZ - i * o.step) * 1000) / 1000,
    x: x0 + i * (o.size + o.gap),
    y: o.cy - o.size / 2,
    size: o.size,
  }));
}

export function heightTest(o: HeightTestOptions): { paths: PlotPath[]; squares: HeightSquare[]; notes: string[]; minZ: number } {
  const squares = heightTestSquares(o);
  const paths: PlotPath[] = squares.map((s) => ({
    z: s.z,
    pts: [
      { x: s.x, y: s.y },
      { x: s.x + s.size, y: s.y },
      { x: s.x + s.size, y: s.y + s.size },
      { x: s.x, y: s.y + s.size },
      { x: s.x, y: s.y },
    ],
  }));
  const notes = [
    'PEN-HEIGHT TEST — squares left to right (front view), each one step closer to the pen:',
    ...squares.map((s) => `  Square ${s.index}: pen-down Z ${fmt(s.z)}`),
    'Pick the FIRST square that is drawn cleanly all the way round and set that as pen-down Z.',
  ];
  return { paths, squares, notes, minZ: Math.min(...squares.map((s) => s.z)) };
}

export interface OffsetTestOptions {
  squareSize: number;
  crossArm: number;
}

/** Crosshair at bed centre, a known square around it, and X / Y labels on the +arms. */
export function offsetTest(prof: Profile, o: OffsetTestOptions): { paths: PlotPath[]; notes: string[] } {
  const cx = prof.bedW / 2, cy = prof.bedH / 2;
  const a = o.crossArm, s = o.squareSize / 2;
  const lines: Polyline[] = [
    [{ x: cx - a, y: cy }, { x: cx + a, y: cy }],
    [{ x: cx, y: cy - a }, { x: cx, y: cy + a }],
    [{ x: cx - s, y: cy - s }, { x: cx + s, y: cy - s }, { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s }, { x: cx - s, y: cy - s }],
  ];
  const label = (t: string, x: number, y: number) =>
    renderText(t, { size: 4 }).map((p) => p.map((q) => ({ x: q.x + x, y: q.y + y })));
  lines.push(...label('X', cx + a + 1.5, cy - 2), ...label('Y', cx - 1.5, cy + a + 1.5));
  return {
    paths: lines.map((pts) => ({ pts })),
    notes: [
      `OFFSET TEST — crosshair should land on bed centre X ${fmt(cx)} Y ${fmt(cy)} (measured from the bed's front-left corner).`,
      `Square is ${fmt(o.squareSize)} x ${fmt(o.squareSize)} mm centred on the crosshair — measure it to check scale.`,
      `Nozzle is commanded to X ${fmt(cx - prof.penOffsetX)} Y ${fmt(cy - prof.penOffsetY)} for the crosshair centre (current offset X ${fmt(prof.penOffsetX)} Y ${fmt(prof.penOffsetY)}).`,
      'Method A: jog the NOZZLE directly over the crosshair centre and read X/Y: new offset = readout - commanded nozzle position.',
      'Method B: if the crosshair lands dX mm right / dY mm toward the back of centre, ADD dX / dY to the pen offset.',
    ],
  };
}
