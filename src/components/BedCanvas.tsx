import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bounds, Polyline, Pt } from '../lib/geometry';
import type { HeightSquare } from '../lib/calibration';
import { type Instance, type RawSize, orientedBox } from '../lib/board';

/** Rotate-handle distance above the box and touch hit radius, in screen pixels. */
export const HANDLE_PX = 26;
export const HIT_PX = 20;

export interface BoardOverlay {
  instances: Instance[];
  raw: RawSize;
  selectedId: string | null;
  badIds: Set<string>;
  paper: Bounds | null;
}

export type BoardPointer = (type: 'down' | 'move' | 'up', pt: Pt, pxPerMm: number, e: React.PointerEvent) => void;
import type { Profile } from '../lib/profile';

export interface PreviewMove {
  kind: 'draw' | 'travel';
  from: Pt; // pen-tip coordinates
  to: Pt;
}

interface Props {
  profile: Profile;
  area: Bounds;
  moves: PreviewMove[];
  /** number of moves already "plotted" in playback; null = show everything */
  progress: number | null;
  ghost?: Polyline[];
  squares?: HeightSquare[];
  selectedSquare?: number | null;
  onSquareClick?: (index: number) => void;
  showTravel: boolean;
  board?: BoardOverlay;
  onBoardPointer?: BoardPointer;
}

const GOLD = '#d4a017';
const TRAVEL = '#38bdf8';
const PAD = 26;

export function BedCanvas({ profile, area, moves, progress, ghost, squares, selectedSquare, onSquareClick, showTravel, board, onBoardPointer }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(360);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bw = profile.bedW, bh = profile.bedH;
  const s = (width - 2 * PAD) / bw; // px per mm, identical on both axes (true scale)
  const height = Math.round(bh * s + 2 * PAD);
  const X = useCallback((x: number) => PAD + x * s, [s]);
  const Y = useCallback((y: number) => PAD + (bh - y) * s, [s, bh]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);

    // bed
    g.fillStyle = '#0e0e0e';
    g.fillRect(X(0), Y(bh), bw * s, bh * s);
    for (let v = 0; v <= Math.max(bw, bh); v += 10) {
      const major = v % 50 === 0;
      g.strokeStyle = major ? '#2b2b2b' : '#1a1a1a';
      g.lineWidth = 1;
      if (v <= bw) { g.beginPath(); g.moveTo(X(v) + 0.5, Y(0)); g.lineTo(X(v) + 0.5, Y(bh)); g.stroke(); }
      if (v <= bh) { g.beginPath(); g.moveTo(X(0), Y(v) + 0.5); g.lineTo(X(bw), Y(v) + 0.5); g.stroke(); }
    }
    // unreachable zones (pen offset shifts the reachable window)
    g.save();
    g.beginPath();
    g.rect(X(0), Y(bh), bw * s, bh * s);
    g.rect(X(area.maxX), Y(area.maxY), -(area.maxX - area.minX) * s, (area.maxY - area.minY) * s);
    g.fillStyle = 'rgba(224,73,62,0.13)';
    g.fill('evenodd');
    g.restore();
    g.setLineDash([4, 4]);
    g.strokeStyle = '#6b6b6b';
    g.strokeRect(X(area.minX), Y(area.maxY), (area.maxX - area.minX) * s, (area.maxY - area.minY) * s);
    g.setLineDash([]);
    g.strokeStyle = '#a07812';
    g.lineWidth = 1.5;
    g.strokeRect(X(0), Y(bh), bw * s, bh * s);

    // axis labels
    g.fillStyle = '#6a6a6a';
    g.font = '600 10px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let v = 0; v <= bw; v += 50) g.fillText(String(v), X(v), Y(0) + 5);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let v = 50; v <= bh; v += 50) g.fillText(String(v), X(0) - 4, Y(v));
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText('BACK', X(bw / 2), Y(bh) - 6);
    g.textBaseline = 'top';
    g.fillText('FRONT', X(bw / 2), Y(0) + 14);

    // paper outline (may extend past the bed)
    if (board?.paper) {
      const pr = board.paper;
      g.save();
      g.fillStyle = 'rgba(232,232,232,0.045)';
      g.fillRect(X(pr.minX), Y(pr.maxY), (pr.maxX - pr.minX) * s, (pr.maxY - pr.minY) * s);
      g.strokeStyle = 'rgba(232,232,232,0.55)';
      g.lineWidth = 1.2;
      g.setLineDash([8, 3, 2, 3]);
      g.strokeRect(X(pr.minX), Y(pr.maxY), (pr.maxX - pr.minX) * s, (pr.maxY - pr.minY) * s);
      g.setLineDash([]);
      g.fillStyle = 'rgba(232,232,232,0.6)';
      g.font = '700 9px ui-monospace, Menlo, monospace';
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText('PAPER', X(Math.max(pr.minX, 0)) + 3, Y(Math.max(pr.minY, 0)) - 3);
      g.restore();
    }

    // ghost of the unclipped design (red where it leaves the reachable area)
    if (ghost?.length) {
      g.strokeStyle = 'rgba(224,73,62,0.55)';
      g.lineWidth = 1;
      g.beginPath();
      for (const p of ghost) {
        g.moveTo(X(p[0].x), Y(p[0].y));
        for (let i = 1; i < p.length; i++) g.lineTo(X(p[i].x), Y(p[i].y));
      }
      g.stroke();
    }

    const done = progress === null ? moves.length : Math.max(0, Math.min(moves.length, progress));
    const drawSet = (from: number, to: number, kind: 'draw' | 'travel', style: string, lw: number, dash: number[]) => {
      g.strokeStyle = style;
      g.lineWidth = lw;
      g.setLineDash(dash);
      g.beginPath();
      for (let i = from; i < to; i++) {
        const m = moves[i];
        if (m.kind !== kind) continue;
        g.moveTo(X(m.from.x), Y(m.from.y));
        g.lineTo(X(m.to.x), Y(m.to.y));
      }
      g.stroke();
      g.setLineDash([]);
    };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // not-yet-plotted part (playback)
    if (done < moves.length) {
      drawSet(done, moves.length, 'draw', 'rgba(212,160,23,0.22)', 1.2, []);
      if (showTravel) drawSet(done, moves.length, 'travel', 'rgba(56,189,248,0.18)', 1, [4, 4]);
    }
    drawSet(0, done, 'draw', GOLD, Math.max(1.2, Math.min(2.2, s * 0.5)), []);
    if (showTravel) drawSet(0, done, 'travel', TRAVEL, 1, [5, 4]);

    // copies on the board: boxes, numbers and handles for the selected one
    if (board && board.instances.length) {
      const off = HANDLE_PX / s;
      g.lineWidth = 1;
      board.instances.forEach((inst, idx) => {
        const b = orientedBox(inst, board.raw, off);
        const sel = inst.id === board.selectedId;
        const bad = board.badIds.has(inst.id);
        g.strokeStyle = bad ? 'rgba(224,73,62,0.9)' : sel ? 'rgba(212,160,23,0.95)' : 'rgba(138,138,138,0.45)';
        g.lineWidth = sel ? 1.5 : 1;
        g.setLineDash(sel ? [6, 4] : [3, 4]);
        g.beginPath();
        b.corners.forEach((c, i) => (i ? g.lineTo(X(c.x), Y(c.y)) : g.moveTo(X(c.x), Y(c.y))));
        g.closePath();
        g.stroke();
        g.setLineDash([]);
        if (board.instances.length > 1 || sel) {
          // number badge just inside the back-left corner (the corner itself is a handle)
          const c0 = b.corners[0], dx = b.center.x - c0.x, dy = b.center.y - c0.y, dl = Math.hypot(dx, dy) || 1;
          const inset = Math.min(dl * 0.5, 16 / s);
          const tl = { x: c0.x + (dx / dl) * inset, y: c0.y + (dy / dl) * inset };
          g.fillStyle = bad ? '#e0493e' : sel ? '#d4a017' : '#5a5a5a';
          g.beginPath();
          g.arc(X(tl.x), Y(tl.y), 8, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = sel || bad ? '#0a0a0a' : '#e8e8e8';
          g.font = '900 10px Inter, system-ui, sans-serif';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(String(idx + 1), X(tl.x), Y(tl.y) + 0.5);
        }
        if (sel) {
          const topMid = { x: (b.corners[0].x + b.corners[1].x) / 2, y: (b.corners[0].y + b.corners[1].y) / 2 };
          g.strokeStyle = '#d4a017';
          g.beginPath(); g.moveTo(X(topMid.x), Y(topMid.y)); g.lineTo(X(b.rotHandle.x), Y(b.rotHandle.y)); g.stroke();
          g.fillStyle = '#0a0a0a';
          g.lineWidth = 2;
          g.beginPath(); g.arc(X(b.rotHandle.x), Y(b.rotHandle.y), 7, 0, Math.PI * 2); g.fill(); g.stroke();
          g.fillStyle = '#d4a017';
          g.font = '900 10px Inter, system-ui, sans-serif';
          g.fillText('⟳', X(b.rotHandle.x), Y(b.rotHandle.y) + 0.5);
          for (const c of b.corners) {
            g.fillStyle = '#d4a017';
            g.fillRect(X(c.x) - 6, Y(c.y) - 6, 12, 12);
            g.strokeStyle = '#0a0a0a';
            g.lineWidth = 1.5;
            g.strokeRect(X(c.x) - 6, Y(c.y) - 6, 12, 12);
          }
        }
      });
    }

    // calibration square labels
    if (squares?.length) {
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.font = '900 12px Inter, system-ui, sans-serif';
      for (const q of squares) {
        const sel = q.index === selectedSquare;
        if (sel) {
          g.strokeStyle = '#22c55e';
          g.lineWidth = 2;
          g.strokeRect(X(q.x) - 3, Y(q.y + q.size) - 3, q.size * s + 6, q.size * s + 6);
        }
        g.fillStyle = sel ? '#22c55e' : '#e8e8e8';
        g.fillText(String(q.index), X(q.x + q.size / 2), Y(q.y + q.size) - 5);
      }
    }

    // pen head marker at the current playback position + nozzle ghost
    const cur = done > 0 ? moves[done - 1].to : moves[0]?.from;
    if (cur && progress !== null) {
      const nx = cur.x - profile.penOffsetX, ny = cur.y - profile.penOffsetY;
      g.strokeStyle = '#8a8a8a';
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(X(cur.x), Y(cur.y)); g.lineTo(X(nx), Y(ny)); g.stroke();
      g.setLineDash([]);
      g.beginPath(); g.arc(X(nx), Y(ny), 5, 0, Math.PI * 2); g.stroke();
      const m = moves[Math.max(0, done - 1)];
      g.fillStyle = m?.kind === 'travel' && done > 0 ? TRAVEL : '#22c55e';
      g.beginPath(); g.arc(X(cur.x), Y(cur.y), 4.5, 0, Math.PI * 2); g.fill();
    }
  }, [width, height, s, X, Y, bw, bh, area, moves, progress, ghost, squares, selectedSquare, profile.penOffsetX, profile.penOffsetY, showTravel, board]);

  const toMm = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left - PAD) / s, y: bh - (e.clientY - r.top - PAD) / s };
  };
  const dragging = useRef(false);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!squares?.length || !onSquareClick) return;
    const r = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - r.left - PAD) / s;
    const my = bh - (e.clientY - r.top - PAD) / s;
    const hit = squares.find((q) => mx >= q.x - 3 && mx <= q.x + q.size + 3 && my >= q.y - 3 && my <= q.y + q.size + 8);
    if (hit) onSquareClick(hit.index);
  };

  return (
    <div className="bed-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={squares?.length ? 'bed clickable' : onBoardPointer ? 'bed board' : 'bed'}
        style={{ width, height }}
        onClick={onClick}
        onPointerDown={onBoardPointer ? (e) => {
          dragging.current = true;
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          onBoardPointer('down', toMm(e), s, e);
        } : undefined}
        onPointerMove={onBoardPointer ? (e) => { if (dragging.current) onBoardPointer('move', toMm(e), s, e); } : undefined}
        onPointerUp={onBoardPointer ? (e) => { if (dragging.current) { dragging.current = false; onBoardPointer('up', toMm(e), s, e); } } : undefined}
        onPointerCancel={onBoardPointer ? (e) => { if (dragging.current) { dragging.current = false; onBoardPointer('up', toMm(e), s, e); } } : undefined}
        role="img"
        aria-label={`Bed preview ${bw} by ${bh} mm`}
      />
    </div>
  );
}
