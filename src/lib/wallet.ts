/**
 * Wallet sequence: turns an EVM address into a deterministic Slab Simulator sequence.
 * Two keys: Raw (the 40 checksummed address chars) and Hashed (keccak-256 of the 20 address bytes).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { type Optics, type Pt, type Step, type StepAction, SLAB_H, SLAB_W, mkStep, spotPositions } from './slab';

export type WalletKey = 'raw' | 'hashed';
export type KeyVersion = 'v1' | 'v2' | 'v3';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const keccakHex = (s: string) => hex(keccak_256(new TextEncoder().encode(s)));

/** EIP-55 style casing: letter i is uppercase when nibble i of keccak(lowercase string) is >= 8. */
export function caseByHash(lower: string): string {
  const h = keccakHex(lower);
  return Array.from(lower, (c, i) => (/[a-f]/.test(c) && parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

export type ParsedAddress = { ok: true; checksum: string; lower: string; fixedCase: boolean } | { ok: false; error: string };

/** Validates `0x` + 40 hex. All-lower / all-upper gets EIP-55 casing; mixed case must match its checksum. */
export function parseAddress(input: string): ParsedAddress {
  const t = input.trim();
  const m = /^0x([0-9a-fA-F]{40})$/i.exec(t);
  if (!m) return { ok: false, error: t.length ? 'Not an address: needs 0x followed by 40 hex characters (0-9, a-f).' : 'Paste a wallet address.' };
  const body = m[1];
  const lower = body.toLowerCase();
  const checksum = caseByHash(lower);
  const mixed = body !== lower && body !== body.toUpperCase();
  if (mixed && body !== checksum) return { ok: false, error: 'Checksum mismatch: the upper/lower case letters do not match this address. Check for a typo.' };
  return { ok: true, checksum: `0x${checksum}`, lower: `0x${lower}`, fixedCase: !mixed };
}

/** The 40 source characters for a key. */
export function sourceChars(lowerAddr: string, key: WalletKey): string {
  const body = lowerAddr.replace(/^0x/i, '').toLowerCase();
  if (key === 'raw') return caseByHash(body);
  const bytes = new Uint8Array(body.match(/../g)!.map((b) => parseInt(b, 16)));
  return caseByHash(hex(keccak_256(bytes))).slice(0, 40);
}

export interface Decoded { pos: number; ch: string; text: string }
export interface WalletSequence {
  name: string; source: string; optics: Optics; steps: Step[]; decoded: Decoded[]; opticText: string;
  /** v3: decoded motifs grouped by round, target minutes, stats */
  rounds?: { round: number; motifs: Decoded[] }[];
  targetMin?: number;
  rows?: number;
}

const MOVE_MM = [1, 2, 3, 5];
const ROT_DEG = [5, 10, 15, 30];
const CIRCLE_MM = [1, 2, 3, 5];
const DWELL_S = [2, 3, 4, 6];
export const SNAP_DWELL_S = 4;
export const BOUND_Y = 20;
export const DRIFT_EVERY = 10;

/** Bounds for the centre spot / rotation so every spot stays on the 150 x 68 face. */
export function walletBounds(optics: Optics) {
  const maxR = Math.max(...spotPositions(optics).map((p) => Math.abs(p.x)));
  return {
    x: Math.min(45, Math.max(10, 72 - maxR)),
    y: BOUND_Y,
    rot: maxR > 28 ? Math.floor((Math.asin(Math.min(1, 28 / maxR)) * 180) / Math.PI) : 35,
  };
}

export function walletSequence(address: string, key: WalletKey, version: KeyVersion = 'v3'): WalletSequence {
  return version === 'v3' ? walletSequenceV3(address, key) : version === 'v2' ? walletSequenceV2(address, key) : walletSequenceV1(address, key);
}

function walletSequenceV1(address: string, key: WalletKey): WalletSequence {
  const p = parseAddress(address);
  if (!p.ok) throw new Error(p.error);
  const src = sourceChars(p.lower, key);
  // ---- optic from the first byte
  const b = parseInt(src.slice(0, 2), 16);
  const kind = (['none', 'prism', 'cube'] as const)[b % 3];
  const optics: Optics = { kind, distance: -Math.round(((b >> 4) / 15) * 20), prismAngle: 5 + ((b >> 1) & 7) * 3 };
  const opticText = kind === 'none' ? 'no optic (single centre spot)'
    : kind === 'prism' ? `prism ${optics.prismAngle}°, ${optics.distance} mm from zero` : `diffraction cube, ${optics.distance} mm from zero`;
  const bounds = walletBounds(optics);
  // ---- pose tracking: slab translation (tx, ty) and rotation (deg, CW +)
  let tx = 0, ty = 0, rot = 0;
  const centreSpot = (x: number, y: number, r: number) => {
    const a = (r * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: c * -x - s * -y, y: s * -x + c * -y };
  };
  const over = (x: number, y: number, r: number) => {
    const q = centreSpot(x, y, r);
    return Math.max(0, Math.abs(q.x) - bounds.x) + Math.max(0, Math.abs(q.y) - bounds.y) + Math.max(0, Math.abs(r) - bounds.rot);
  };
  const steps: Step[] = [];
  const decoded: Decoded[] = [];
  for (let pos = 2; pos < 40; pos++) {
    const j = pos - 2; // step index
    const ch = src[pos];
    const n = parseInt(ch, 16);
    const act = n >> 2, size = n & 3;
    const isLetter = /[a-fA-F]/.test(ch);
    const positive = isLetter ? ch === ch.toUpperCase() : (n + pos) % 2 === 0;
    const steady = j % 2 === 0;
    const parts: string[] = [];
    let action: StepAction, amount: number, dur: number;
    if (act === 3) {
      if (positive) { action = 'circle'; amount = CIRCLE_MM[size]; dur = steady ? 4 : 1; }
      else { action = 'dwell'; amount = 0; dur = DWELL_S[size]; }
    } else {
      const sign0 = positive ? 1 : -1;
      const amt = act === 2 ? ROT_DEG[size] : MOVE_MM[size];
      const apply = (sg: number) => act === 0 ? [tx, ty + sg * amt, rot] : act === 1 ? [tx + sg * amt, ty, rot] : [tx, ty, rot + sg * amt];
      let sign = sign0;
      const a1 = apply(sign0), a2 = apply(-sign0);
      if (over(a1[0], a1[1], a1[2]) > 0 && over(a2[0], a2[1], a2[2]) < over(a1[0], a1[1], a1[2])) { sign = -sign0; parts.push('flipped to stay on the face'); }
      [tx, ty, rot] = apply(sign);
      action = act === 0 ? (sign > 0 ? 'up' : 'down') : act === 1 ? (sign > 0 ? 'right' : 'left') : (sign > 0 ? 'cw' : 'ccw');
      amount = amt;
      dur = steady ? (act === 2 ? (amt / 5) * 2 : amt) : 1;
    }
    steps.push(mkStep(action, amount, dur, 1));
    const label = action === 'dwell' ? `dwell ${dur} s` : action === 'circle' ? `circle ⌀${amount} mm in ${dur} s`
      : `${action === 'cw' || action === 'ccw' ? action.toUpperCase() : action} ${amount}${action === 'cw' || action === 'ccw' ? '°' : ' mm'} in ${dur} s`;
    let text = `${label}${steady || action === 'dwell' ? '' : ` (snap) + dwell ${SNAP_DWELL_S} s`}`;
    if (!steady && action !== 'dwell') steps.push(mkStep('dwell', 0, SNAP_DWELL_S, 1));
    // gentle drift-back toward the centre every DRIFT_EVERY key steps
    if ((j + 1) % DRIFT_EVERY === 0) {
      const dx = Math.round(-tx * 0.25 * 2) / 2, dy = Math.round(-ty * 0.25 * 2) / 2;
      const drift: string[] = [];
      if (Math.abs(dx) >= 1) { steps.push(mkStep(dx > 0 ? 'right' : 'left', Math.abs(dx), Math.abs(dx), 1)); tx += dx; drift.push(`${dx > 0 ? 'right' : 'left'} ${Math.abs(dx)} mm`); }
      if (Math.abs(dy) >= 1) { steps.push(mkStep(dy > 0 ? 'up' : 'down', Math.abs(dy), Math.abs(dy), 1)); ty += dy; drift.push(`${dy > 0 ? 'up' : 'down'} ${Math.abs(dy)} mm`); }
      if (drift.length) parts.push(`then drift back ${drift.join(', ')}`);
    }
    if (parts.length) text += ` — ${parts.join('; ')}`;
    decoded.push({ pos, ch, text });
  }
  const c = p.checksum;
  return { name: `Wallet ${c.slice(0, 6)}…${c.slice(-4)} (${key} v1)`, source: src, optics, steps, decoded, opticText };
}

// ------------------------------------------------------------------ v2: circle-heavy key

export const MOVE16 = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36];
export const ROT16 = [5, 10, 15, 20, 25, 30, 40, 45, 50, 60, 70, 80, 90, 100, 120, 150];
export const RING16 = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20];
export const V2_DOT_S = 3;
/** spot speed around rings / circles / spirals (mm/s) so every pass is bright enough to plot */
export const RING_SPEED = 3;
export const ringRevFor = (dia: number) => Math.max(1, Math.round(((Math.PI * dia) / RING_SPEED) * 10) / 10);

function opticFrom(src: string) {
  const b = parseInt(src.slice(0, 2), 16);
  const kind = (['none', 'prism', 'cube'] as const)[b % 3];
  const optics: Optics = { kind, distance: -Math.round(((b >> 4) / 15) * 20), prismAngle: 5 + ((b >> 1) & 7) * 3 };
  const opticText = kind === 'none' ? 'no optic (single centre spot)'
    : kind === 'prism' ? `prism ${optics.prismAngle}°, ${optics.distance} mm from zero` : `diffraction cube, ${optics.distance} mm from zero`;
  return { optics, opticText };
}

/**
 * v2: the 38 step chars are read in 19 pairs (one byte each). High nibble top 2 bits = action:
 * 0 ring move, 1 arc (rotation, with rings on a capital 2nd char), 2 circle, 3 spiral.
 * Low nibble = size (16 steps: moves 2-36 mm, arcs 5-150°, circles/spirals 1-20 mm).
 * Ring size = RING16[(hi & 3) * 4 + (lo & 3)] (1-20 mm). First char case = direction, second char case = variant.
 */
function walletSequenceV2(address: string, key: WalletKey): WalletSequence {
  const p = parseAddress(address);
  if (!p.ok) throw new Error(p.error);
  const src = sourceChars(p.lower, key);
  const { optics, opticText } = opticFrom(src);
  const b1 = walletBounds(optics);
  const bounds = { ...b1, rot: optics.kind === 'cube' ? b1.rot : 180 };
  let tx = 0, ty = 0, rot = 0;
  const over = (x: number, y: number, r: number, margin: number) => {
    const a = (r * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const qx = -c * x + s * y, qy = -s * x - c * y;
    return Math.max(0, Math.abs(qx) + margin - bounds.x) + Math.max(0, Math.abs(qy) + margin - bounds.y) + Math.max(0, Math.abs(r) - bounds.rot);
  };
  /** largest circle diameter that fits around the centre spot right now */
  const room = () => {
    const a = (rot * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    const qx = -c * tx + sn * ty, qy = -sn * tx - c * ty;
    return Math.max(1, 2 * Math.min(bounds.x - Math.abs(qx), bounds.y - Math.abs(qy)));
  };
  const fit = (dia: number) => Math.min(dia, Math.floor(room() * 2) / 2);
  const caseBit = (ch: string, pos: number) => (/[a-fA-F]/.test(ch) ? ch === ch.toUpperCase() : (parseInt(ch, 16) + pos) % 2 === 0);
  const steps: Step[] = [];
  const decoded: Decoded[] = [];
  for (let pos = 2, j = 0; pos + 1 < 40; pos += 2, j++) {
    const c1 = src[pos], c2 = src[pos + 1];
    const hi = parseInt(c1, 16), lo = parseInt(c2, 16);
    const act = hi >> 2;
    const ring = RING16[(hi & 3) * 4 + (lo & 3)];
    const positive = caseBit(c1, pos), variant = caseBit(c2, pos + 1);
    const notes: string[] = [];
    let text = '';
    if (act === 0 || act === 1) {
      // ring move (straight, rings traced the whole way) or arc (rotation about the slab centre)
      const isMove = act === 0;
      const wantRing = isMove || variant ? ring : 0;
      const ringDia = wantRing ? fit(wantRing) : 0;
      if (ringDia < wantRing) notes.push(`rings shrunk from ⌀${wantRing}`);
      const full = isMove ? MOVE16[lo] : ROT16[lo];
      const margin = ringDia / 2 + 1;
      const tryPose = (sg: number, amt: number): [number, number, number] =>
        isMove ? (variant ? [tx, ty + sg * amt, rot] : [tx + sg * amt, ty, rot]) : [tx, ty, rot + sg * amt];
      const sign0 = positive ? 1 : -1;
      let chosen: [number, number] | null = null;
      for (const k of [1, 0.75, 0.5, 0.25]) {
        for (const sg of [sign0, -sign0]) {
          const amt = Math.round(full * k * 2) / 2;
          const q = tryPose(sg, amt);
          const ok = isMove ? over(q[0], q[1], q[2], margin) === 0
            : [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].every((f) => over(tx, ty, rot + sg * amt * f, margin) === 0);
          if (amt > 0 && ok) { chosen = [sg, amt]; break; }
        }
        if (chosen) break;
      }
      if (!chosen) {
        const rd = fit(Math.max(1, ringDia));
        steps.push({ ...mkStep('dwell', 0, 4, 1), ring: rd, ringRev: ringRevFor(rd) });
        text = `no room to move: rings ⌀${rd} mm in place for 4 s`;
      } else {
        const [sg, amt] = chosen;
        if (sg !== sign0) notes.push('flipped to stay on the face');
        if (amt !== full) notes.push(`shortened from ${full}`);
        [tx, ty, rot] = tryPose(sg, amt);
        const action: StepAction = isMove ? (variant ? (sg > 0 ? 'up' : 'down') : (sg > 0 ? 'right' : 'left')) : (sg > 0 ? 'cw' : 'ccw');
        // with rings the slab moves half a ring diameter per ring turn, so the rings interlock
        const rev = ringDia > 0 ? ringRevFor(ringDia) : 0;
        const dur = Math.round((isMove ? (ringDia > 0 ? (amt * 2 * rev) / ringDia : amt) : Math.max(2, amt / 2.5)) * 10) / 10;
        const st = mkStep(action, amt, dur, 1);
        if (ringDia > 0) { st.ring = ringDia; st.ringRev = rev; }
        steps.push(st);
        const what = isMove ? `${action} ${amt} mm` : `${action.toUpperCase()} ${amt}° arc`;
        text = `${what} in ${fmtS(dur)}${ringDia ? ` with rings ⌀${ringDia} mm` : ''}`;
      }
    } else if (act === 2) {
      const want = RING16[lo];
      const dia = fit(want);
      if (dia < want) notes.push(`shrunk from ⌀${want} to fit`);
      const reps = 1 + (hi & 3);
      const dur = Math.max(2, Math.round(((Math.PI * dia) / RING_SPEED) * 2) / 2);
      steps.push(mkStep('circle', dia, dur, reps));
      text = `circle ⌀${dia} mm × ${reps} (${fmtS(dur)} each)`;
      if (variant) { steps.push(mkStep('dwell', 0, V2_DOT_S, 1)); text += ` + dwell ${V2_DOT_S} s`; }
    } else {
      const want = Math.max(3, RING16[lo]);
      const dia = fit(want);
      if (dia < want) notes.push(`shrunk from ⌀${want} to fit`);
      const turns = variant ? 5 : 3;
      const dur = Math.max(4, Math.round(((Math.PI * (dia / 2) * turns) / RING_SPEED) * 2) / 2);
      steps.push({ ...mkStep('spiral', dia, dur, 1), turns });
      text = `spiral out to ⌀${dia} mm, ${turns} turns in ${dur} s`;
    }
    if (j % 2 === 1 && act !== 2) { steps.push(mkStep('dwell', 0, V2_DOT_S, 1)); text += ` + dwell ${V2_DOT_S} s (dot)`; }
    if (notes.length) text += ` — ${notes.join('; ')}`;
    decoded.push({ pos, ch: c1 + c2, text });
  }
  const c = p.checksum;
  return { name: `Wallet ${c.slice(0, 6)}…${c.slice(-4)} (${key} v2)`, source: src, optics, steps, decoded, opticText };
}
const fmtS = (s: number) => `${Math.round(s * 10) / 10} s`;

// ------------------------------------------------------------------ v3: whole-face tour, 10-30 min runs

export const TOUR_COLS = 6, TOUR_ROWS = 3;
const STRIDES = [7, 11, 13, 17, 19, 23, 29, 31, 37, 3, 9, 21, 27, 33, 39];
/** speed tiers: pale (fast), medium, bright (slow) */
const TIER_NAMES = ['pale', 'medium', 'bright'];
const LINE_V = [4, 1.5, 0.7]; // mm/s
const RING_V = [5, 3, 1.5]; // mm/s around a ring / circle / spiral
const MAX_DWELL_PER_CELL = 12; // s of dot dwell allowed per 4 mm cell
const POS_V = 40; // mm/s positioning (pale, skipped in G-code)
const MAX_RUN_S = 30 * 60;

interface Pair { hi: number; lo: number; up1: boolean; up2: boolean; round: number }

/** Endless, deterministic stream of byte pairs from the address. */
export function* pairStream(lowerAddr: string, key: WalletKey): Generator<Pair> {
  const body = lowerAddr.replace(/^0x/i, '').toLowerCase();
  const caseBit = (ch: string, pos: number) => (/[a-fA-F]/.test(ch) ? ch === ch.toUpperCase() : (parseInt(ch, 16) + pos) % 2 === 0);
  if (key === 'raw') {
    const src = caseByHash(body);
    const first = parseInt(src.slice(0, 2), 16);
    for (let round = 0; ; round++) {
      const stride = round === 0 ? 1 : STRIDES[(round - 1) % STRIDES.length];
      const off = round === 0 ? 0 : (round * 13 + first) % 40;
      for (let k = 0; k < 40; k += 2) {
        const a = (off + k * stride) % 40, b = (off + (k + 1) * stride) % 40;
        yield { hi: parseInt(src[a], 16), lo: parseInt(src[b], 16), up1: caseBit(src[a], k + round), up2: caseBit(src[b], k + 1 + round), round };
      }
    }
  } else {
    let h = keccak_256(new Uint8Array(body.match(/../g)!.map((x) => parseInt(x, 16))));
    for (let round = 0; ; round++) {
      const src = caseByHash(hex(h));
      for (let k = 0; k < 64; k += 2) {
        yield { hi: parseInt(src[k], 16), lo: parseInt(src[k + 1], 16), up1: caseBit(src[k], k + round), up2: caseBit(src[k + 1], k + 1 + round), round };
      }
      h = keccak_256(h); // keccak chain h(n+1) = keccak(h(n))
    }
  }
}

function walletSequenceV3(address: string, key: WalletKey): WalletSequence {
  const p = parseAddress(address);
  if (!p.ok) throw new Error(p.error);
  const src = sourceChars(p.lower, key);
  const stream = pairStream(p.lower, key);
  const next = () => stream.next().value as Pair;
  const op = next();
  const { optics, opticText } = opticFrom(op.hi.toString(16) + op.lo.toString(16));
  const tp = next();
  const targetMin = 10 + (((tp.hi << 4) | tp.lo) % 21);
  const target = targetMin * 60;
  // shorter runs use shorter passes so every run still has hundreds of rows
  const pace = Math.min(1.4, Math.max(0.55, targetMin / 20));
  const spots = spotPositions(optics);
  const ax = spots.reduce((a, q) => a + q.x, 0) / spots.length; // anchor = middle of the spot pattern
  const spread = Math.max(...spots.map((q) => Math.abs(q.x - ax)));
  const SPOT_R = 1;
  const HX = SLAB_W / 2, HY = SLAB_H / 2;
  // anchor (pattern centre) may roam this rectangle with rot = 0
  const roamX = Math.max(4, HX - spread - SPOT_R - 2), roamY = HY - SPOT_R - 2;
  // pose
  let tx = 0, ty = 0, rot = 0, total = 0, rows = 0;
  const steps: Step[] = [];
  const push = (st: Step) => { steps.push(st); total += st.duration * st.repeat; rows += st.repeat; };
  const onSlab = (x: number, y: number, r: number): Pt[] => {
    const a = (r * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    return spots.map((q) => { const dx = q.x - x, dy = q.y - y; return { x: c * dx - sn * dy, y: sn * dx + c * dy }; });
  };
  /** every spot (plus margin) on the face at this pose */
  const fits = (x: number, y: number, r: number, m: number) => onSlab(x, y, r).every((q) => Math.abs(q.x) <= HX - m && Math.abs(q.y) <= HY - m);
  const anchorNow = () => { const a = (rot * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a); const dx = ax - tx, dy = -ty; return { x: c * dx - sn * dy, y: sn * dx + c * dy }; };
  /** room for a circle of radius r around the anchor */
  const roomR = () => {
    for (let r = 10; r >= 0.5; r -= 0.5) if (fits(tx, ty, rot, r + SPOT_R + 0.5)) return r;
    return 0.5;
  };
  const dwellUsed = new Map<string, number>();
  const rounds: { round: number; motifs: Decoded[] }[] = [];
  const cellW = (2 * roamX) / TOUR_COLS, cellH = (2 * roamY) / TOUR_ROWS;
  let tour: number[] = [];
  let motifNo = 0;
  while (total < target && motifNo < 400) {
    // ---- next region in a stream-shuffled tour (every region once per lap)
    if (!tour.length) {
      tour = Array.from({ length: TOUR_COLS * TOUR_ROWS }, (_, i) => i);
      for (let i = tour.length - 1; i > 0; i--) { const q = next(); const j = ((q.hi << 4) | q.lo) % (i + 1); [tour[i], tour[j]] = [tour[j], tour[i]]; }
    }
    const cell = tour.shift()!;
    const head = next();
    const col = cell % TOUR_COLS, row = Math.floor(cell / TOUR_COLS);
    const X = -roamX + (col + 0.5 + (head.hi / 15 - 0.5) * 0.7) * cellW;
    const Y = roamY - (row + 0.5 + (head.lo / 15 - 0.5) * 0.7) * cellH;
    const tier = [0, 1, 2, 1][(head.hi ^ head.lo) & 3];
    const k = 4 + ((head.hi + head.lo) % 5);
    const startRows = rows, startT = total;
    const parts: string[] = [];
    // ---- positioning (fast & pale): rotate back to 0, then go straight to the target
    if (Math.abs(rot) > 0.01) { const a = Math.abs(rot); push(mkStep(rot > 0 ? 'ccw' : 'cw', round1(a), round1(Math.max(0.3, a / 60)), 1)); rot = 0; }
    const ntx = ax - X, nty = -Y; // slab translation that puts the anchor at (X, Y)
    const dx = round1(ntx - tx), dy = round1(nty - ty);
    if (Math.abs(dx) >= 0.1) push(mkStep(dx > 0 ? 'right' : 'left', Math.abs(dx), round1(Math.max(0.3, Math.abs(dx) / POS_V)), 1));
    if (Math.abs(dy) >= 0.1) push(mkStep(dy > 0 ? 'up' : 'down', Math.abs(dy), round1(Math.max(0.3, Math.abs(dy) / POS_V)), 1));
    tx += dx; ty += dy;
    // ---- k local primitives
    for (let i = 0; i < k && total < MAX_RUN_S - 60; i++) {
      const q = next();
      const act = q.hi >> 2;
      const v = LINE_V[tier], rv = RING_V[tier];
      if (act === 0 || act === 1) {
        const isMove = act === 0;
        const ringSel = q.hi & 3;
        let ringDia = ringSel && (isMove || q.up2) ? RING16[ringSel * 4 + (q.lo & 3)] : 0;
        ringDia = Math.min(ringDia, Math.floor(roomR() * 2 * 2) / 2);
        const m = ringDia / 2 + SPOT_R + 0.5;
        const sg0 = q.up1 ? 1 : -1;
        const full = isMove ? MOVE16[q.lo] : ROT16[q.lo];
        const tryPose = (sg: number, amt: number): [number, number, number] =>
          isMove ? (q.up2 ? [tx, ty + sg * amt, rot] : [tx + sg * amt, ty, rot]) : [tx, ty, rot + sg * amt];
        let chosen: [number, number] | null = null;
        for (const f of [1, 0.75, 0.5, 0.25]) {
          for (const sg of [sg0, -sg0]) {
            const amt = round1(full * f);
            const ok = isMove ? fits(...tryPose(sg, amt), m) : [0.25, 0.5, 0.75, 1].every((g) => fits(tx, ty, rot + sg * amt * g, m));
            if (amt > 0 && ok) { chosen = [sg, amt]; break; }
          }
          if (chosen) break;
        }
        if (!chosen) continue;
        const [sg, amt] = chosen;
        const r = Math.max(5, Math.hypot(anchorNow().x, anchorNow().y));
        [tx, ty, rot] = tryPose(sg, amt);
        const action: StepAction = isMove ? (q.up2 ? (sg > 0 ? 'up' : 'down') : (sg > 0 ? 'right' : 'left')) : (sg > 0 ? 'cw' : 'ccw');
        const pathLen = isMove ? amt : (r * amt * Math.PI) / 180;
        let dur: number;
        const st = mkStep(action, amt, 1, 1);
        if (ringDia > 0) {
          const rev = Math.max(0.6, round1((Math.PI * ringDia) / rv));
          dur = Math.min(6 * pace, (pathLen * 2 * rev) / ringDia); // half a ring per turn (capped: long ones spread wider)
          st.ring = ringDia; st.ringRev = rev;
        } else dur = Math.min(4 * pace, pathLen / v);
        st.duration = round1(Math.max(0.5, dur));
        push(st);
        // plain lines are etched in several out-and-back passes (each pass deepens the groove)
        const back = ringDia > 0 ? 0 : 1 + 2 * (q.hi & 1);
        if (back) {
          const rev: StepAction = action === 'up' ? 'down' : action === 'down' ? 'up' : action === 'left' ? 'right' : action === 'right' ? 'left' : action === 'cw' ? 'ccw' : 'cw';
          for (let b = 0; b < back; b++) push(mkStep(b % 2 === 0 ? rev : action, amt, st.duration, 1));
          if (back % 2 === 1) [tx, ty, rot] = tryPose(-sg, amt);
        }
        parts.push(`${isMove ? `${action} ${amt} mm` : `${action.toUpperCase()} ${amt}°`}${ringDia ? ` ⌀${ringDia} rings` : ` ×${1 + back} passes`}`);
      } else {
        const want = act === 2 ? RING16[q.lo] : Math.max(3, RING16[q.lo]);
        const dia = Math.min(want, Math.floor(roomR() * 2 * 2) / 2);
        if (act === 2) {
          const reps = 1 + (q.hi & 3);
          push(mkStep('circle', dia, round1(Math.min(4 * pace, Math.max(0.6, (Math.PI * dia) / rv))), reps));
          parts.push(`circle ⌀${dia}×${reps}`);
        } else {
          const turns = q.up2 ? 5 : 3;
          push({ ...mkStep('spiral', dia, round1(Math.min(6 * pace, Math.max(1, (Math.PI * (dia / 2) * turns) / rv))), 1), turns });
          parts.push(`spiral ⌀${dia}`);
        }
      }
    }
    // ---- end-of-motif dot, capped per 4 mm cell so nothing saturates
    const an = anchorNow();
    const ck = `${Math.round(an.x / 4)},${Math.round(an.y / 4)}`;
    const want = [1, 2, 4, 6][head.lo & 3];
    const used = dwellUsed.get(ck) ?? 0;
    const dwell = Math.min(want, MAX_DWELL_PER_CELL - used);
    if (dwell >= 0.5) { push(mkStep('dwell', 0, dwell, 1)); dwellUsed.set(ck, used + dwell); parts.push(`dot ${dwell} s`); }
    motifNo++;
    const text = `region ${String.fromCharCode(65 + col)}${row + 1} · ${TIER_NAMES[tier]} · ${parts.join(', ')} · ${rows - startRows} rows, ${fmtS(total - startT)}`;
    let rd = rounds.find((x) => x.round === head.round);
    if (!rd) { rd = { round: head.round, motifs: [] }; rounds.push(rd); }
    rd.motifs.push({ pos: motifNo, ch: (head.hi.toString(16) + head.lo.toString(16)), text });
    if (total >= MAX_RUN_S - 60) break;
  }
  const c = p.checksum;
  const decoded = rounds.flatMap((r) => r.motifs);
  return {
    name: `Wallet ${c.slice(0, 6)}…${c.slice(-4)} (${key} v3)`, source: src, optics,
    opticText: `${opticText} · target ${targetMin} min`, steps, decoded, rounds, targetMin, rows,
  };
}
const round1 = (n: number) => Math.round(n * 10) / 10;
