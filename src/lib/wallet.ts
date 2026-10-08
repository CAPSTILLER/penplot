/**
 * Wallet sequence: turns an EVM address into a deterministic Slab Simulator sequence.
 * Two keys: Raw (the 40 checksummed address chars) and Hashed (keccak-256 of the 20 address bytes).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { type Optics, type Step, type StepAction, mkStep, spotPositions } from './slab';

export type WalletKey = 'raw' | 'hashed';

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
export interface WalletSequence { name: string; source: string; optics: Optics; steps: Step[]; decoded: Decoded[]; opticText: string }

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

export function walletSequence(address: string, key: WalletKey): WalletSequence {
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
  return { name: `Wallet ${c.slice(0, 6)}…${c.slice(-4)} (${key})`, source: src, optics, steps, decoded, opticText };
}
