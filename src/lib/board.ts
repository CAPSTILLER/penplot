/**
 * The board: several placed copies ("instances") of the current design on one sheet.
 * Pure geometry so it can be unit-tested; the UI only calls these.
 */
import type { Design } from './design';
import type { Bounds, Pt } from './geometry';

export interface Instance {
  id: string;
  /** bed position (pen coordinates) of the design's centre */
  x: number;
  y: number;
  /** horizontal and vertical scale (equal when the aspect ratio is locked) */
  scale: number;
  scaleY: number;
  /** degrees, counter-clockwise */
  rotation: number;
  mirror: boolean;
}

/** Raw (unscaled) size of the design's bounding box. */
export interface RawSize {
  w: number;
  h: number;
}

let counter = 0;
export function newId(): string {
  counter = (counter + 1) % 1e6;
  return `i${Date.now().toString(36)}${counter.toString(36)}`;
}

export function makeInstance(p: Partial<Instance> = {}): Instance {
  const scale = p.scale ?? 1;
  return { id: p.id ?? newId(), x: p.x ?? 110, y: p.y ?? 110, scale, scaleY: p.scaleY ?? scale, rotation: p.rotation ?? 0, mirror: p.mirror ?? false };
}

export function toDesign(name: string, paths: Design['paths'], inst: Instance): Design {
  return { name, paths, x: inst.x, y: inst.y, scale: inst.scale, scaleY: inst.scaleY, rotation: inst.rotation, mirror: inst.mirror };
}

export const normDeg = (d: number) => {
  const r = ((((d + 180) % 360) + 360) % 360) - 180;
  return Math.abs(r) < 1e-9 ? 0 : r;
};

function rot(v: Pt, deg: number): Pt {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Width/height of the instance itself (before rotation), in mm. */
export function instanceSize(inst: Instance, raw: RawSize): { w: number; h: number } {
  return { w: raw.w * Math.abs(inst.scale), h: raw.h * Math.abs(inst.scaleY) };
}

export interface OrientedBox {
  id: string;
  center: Pt;
  /** corners: back-left, back-right, front-right, front-left (in the instance's own frame) */
  corners: [Pt, Pt, Pt, Pt];
  rotHandle: Pt;
  /** axis-aligned extent of the rotated box */
  aabb: Bounds;
}

/** The instance's bounding box after scale and rotation. `rotOffset` = rotate-handle distance (mm). */
export function orientedBox(inst: Instance, raw: RawSize, rotOffset = 8): OrientedBox {
  const { w, h } = instanceSize(inst, raw);
  const c = { x: inst.x, y: inst.y };
  const at = (lx: number, ly: number): Pt => { const r = rot({ x: lx, y: ly }, inst.rotation); return { x: c.x + r.x, y: c.y + r.y }; };
  const corners: [Pt, Pt, Pt, Pt] = [at(-w / 2, h / 2), at(w / 2, h / 2), at(w / 2, -h / 2), at(-w / 2, -h / 2)];
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  return {
    id: inst.id,
    center: c,
    corners,
    rotHandle: at(0, h / 2 + rotOffset),
    aabb: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
  };
}

export type ResizeChange = { width: number } | { height: number } | { percent: number };

/**
 * Apply a width / height / percent edit. With `lock` the aspect ratio (scaleY / scale) is kept;
 * without it only the edited axis changes. Percent always sets both axes to the same scale.
 */
export function resizeInstance(inst: Instance, raw: RawSize, change: ResizeChange, lock: boolean): Instance {
  const ratio = inst.scale !== 0 ? inst.scaleY / inst.scale : 1;
  const min = 1e-4;
  if ('percent' in change) {
    const s = Math.max(min, change.percent / 100);
    return { ...inst, scale: s, scaleY: s };
  }
  if ('width' in change) {
    if (raw.w <= 0) return inst;
    const sx = Math.max(min, change.width / raw.w);
    return { ...inst, scale: sx, scaleY: lock ? sx * ratio : inst.scaleY };
  }
  if (raw.h <= 0) return inst;
  const sy = Math.max(min, change.height / raw.h);
  return { ...inst, scaleY: sy, scale: lock ? sy / ratio : inst.scale };
}

/** Scale an instance so its rotated box fits inside `area` (keeps aspect ratio), centred. */
export function fitInstance(inst: Instance, raw: RawSize, area: Bounds, margin = 5): Instance {
  const unit = orientedBox({ ...inst, x: 0, y: 0, scale: 1, scaleY: inst.scaleY / inst.scale }, raw).aabb;
  const w = unit.maxX - unit.minX, h = unit.maxY - unit.minY;
  const aw = Math.max(1, area.maxX - area.minX - 2 * margin), ah = Math.max(1, area.maxY - area.minY - 2 * margin);
  const k = Math.min(aw / Math.max(w, 1e-6), ah / Math.max(h, 1e-6));
  const ratio = inst.scaleY / inst.scale;
  return { ...inst, scale: k, scaleY: k * ratio, x: (area.minX + area.maxX) / 2, y: (area.minY + area.maxY) / 2 };
}

export interface GridOptions {
  rows: number;
  cols: number;
  gapX: number;
  gapY: number;
  /** scale the copies so the whole grid fills the region (minus margin) */
  autoFit: boolean;
  margin: number;
}

/**
 * Lay out rows x cols copies of `template` (same rotation / mirror / aspect) centred in `region`.
 * Row 1 is at the back (top of the preview); columns run left to right.
 */
export function gridLayout(template: Instance, raw: RawSize, o: GridOptions, region: Bounds): Instance[] {
  const rows = Math.max(1, Math.min(50, Math.round(o.rows)));
  const cols = Math.max(1, Math.min(50, Math.round(o.cols)));
  const ratio = template.scale !== 0 ? template.scaleY / template.scale : 1;
  const unit = orientedBox({ ...template, x: 0, y: 0, scale: 1, scaleY: ratio }, raw).aabb;
  const uw = unit.maxX - unit.minX, uh = unit.maxY - unit.minY;
  let k = template.scale;
  if (o.autoFit) {
    const aw = region.maxX - region.minX - 2 * o.margin - (cols - 1) * o.gapX;
    const ah = region.maxY - region.minY - 2 * o.margin - (rows - 1) * o.gapY;
    k = Math.max(1e-4, Math.min(aw / (cols * Math.max(uw, 1e-6)), ah / (rows * Math.max(uh, 1e-6))));
  }
  const cw = uw * k, ch = uh * k;
  const totalW = cols * cw + (cols - 1) * o.gapX;
  const totalH = rows * ch + (rows - 1) * o.gapY;
  const cx = (region.minX + region.maxX) / 2, cy = (region.minY + region.maxY) / 2;
  const x0 = cx - totalW / 2 + cw / 2;
  const yTop = cy + totalH / 2 - ch / 2;
  const out: Instance[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push({ ...template, id: newId(), scale: k, scaleY: k * ratio, x: x0 + c * (cw + o.gapX), y: yTop - r * (ch + o.gapY) });
  return out;
}

export type HitPart = 'move' | 'scale' | 'rotate';
export interface Hit {
  id: string;
  part: HitPart;
  corner?: number;
}

function insideBox(b: OrientedBox, inst: Instance, raw: RawSize, p: Pt, pad: number): boolean {
  const l = rot({ x: p.x - b.center.x, y: p.y - b.center.y }, -inst.rotation);
  const { w, h } = instanceSize(inst, raw);
  return Math.abs(l.x) <= w / 2 + pad && Math.abs(l.y) <= h / 2 + pad;
}

/** What is under the pointer? Handles of the selected instance win, then the top-most body. */
export function hitTest(instances: Instance[], raw: RawSize, p: Pt, tolMm: number, selectedId: string | null, rotOffset: number): Hit | null {
  const sel = instances.find((i) => i.id === selectedId);
  if (sel) {
    const b = orientedBox(sel, raw, rotOffset);
    const d = (q: Pt) => Math.hypot(q.x - p.x, q.y - p.y);
    if (d(b.rotHandle) <= tolMm) return { id: sel.id, part: 'rotate' };
    let best = -1, bd = tolMm;
    b.corners.forEach((c, i) => { const dd = d(c); if (dd <= bd) { bd = dd; best = i; } });
    if (best >= 0) return { id: sel.id, part: 'scale', corner: best };
    if (insideBox(b, sel, raw, p, tolMm * 0.25)) return { id: sel.id, part: 'move' };
  }
  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i];
    if (insideBox(orientedBox(inst, raw, rotOffset), inst, raw, p, tolMm * 0.25)) return { id: inst.id, part: 'move' };
  }
  return null;
}

/** New instance state while dragging `part` from `start` to `cur` (all mm). */
export function dragInstance(orig: Instance, raw: RawSize, part: HitPart, start: Pt, cur: Pt, lock: boolean, snapDeg = 15): Instance {
  if (part === 'move') return { ...orig, x: orig.x + cur.x - start.x, y: orig.y + cur.y - start.y };
  const c = { x: orig.x, y: orig.y };
  if (part === 'rotate') {
    const a0 = Math.atan2(start.y - c.y, start.x - c.x), a1 = Math.atan2(cur.y - c.y, cur.x - c.x);
    let r = normDeg(orig.rotation + ((a1 - a0) * 180) / Math.PI);
    const snap = Math.round(r / snapDeg) * snapDeg;
    if (Math.abs(snap - r) < 3) r = normDeg(snap);
    return { ...orig, rotation: Math.round(r * 10) / 10 };
  }
  // scale about the centre
  const min = 1e-3;
  if (lock) {
    const d0 = Math.hypot(start.x - c.x, start.y - c.y), d1 = Math.hypot(cur.x - c.x, cur.y - c.y);
    if (d0 < 1e-6) return orig;
    const k = Math.max(min / Math.max(orig.scale, min), d1 / d0);
    return { ...orig, scale: orig.scale * k, scaleY: orig.scaleY * k };
  }
  const l = rot({ x: cur.x - c.x, y: cur.y - c.y }, -orig.rotation);
  return {
    ...orig,
    scale: raw.w > 0 ? Math.max(min, (2 * Math.abs(l.x)) / raw.w) : orig.scale,
    scaleY: raw.h > 0 ? Math.max(min, (2 * Math.abs(l.y)) / raw.h) : orig.scaleY,
  };
}

// ------------------------------------------------------------------ paper -----
export type PaperPreset = 'none' | 'letter' | 'a4' | 'a5' | 'a6' | 'custom';

export interface PaperSettings {
  preset: PaperPreset;
  landscape: boolean;
  customW: number;
  customH: number;
  /** bed position (pen coords) of the paper's front-left corner */
  originX: number;
  originY: number;
}

export const PAPER_SIZES: Record<Exclude<PaperPreset, 'none' | 'custom'>, { w: number; h: number; label: string }> = {
  letter: { w: 215.9, h: 279.4, label: 'US Letter' },
  a4: { w: 210, h: 297, label: 'A4' },
  a5: { w: 148, h: 210, label: 'A5' },
  a6: { w: 105, h: 148, label: 'A6' },
};

export function paperSize(p: PaperSettings): { w: number; h: number } | null {
  if (p.preset === 'none') return null;
  const s = p.preset === 'custom' ? { w: p.customW, h: p.customH } : PAPER_SIZES[p.preset];
  return p.landscape ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}

export function paperRect(p: PaperSettings): Bounds | null {
  const s = paperSize(p);
  if (!s) return null;
  return { minX: p.originX, minY: p.originY, maxX: p.originX + s.w, maxY: p.originY + s.h };
}

export function intersect(a: Bounds, b: Bounds): Bounds {
  return { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) };
}
