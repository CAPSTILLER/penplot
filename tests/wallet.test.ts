import { describe, expect, it } from 'vitest';
import { parseAddress, sourceChars, walletBounds, walletSequence } from '../src/lib/wallet';
import { gridForRuns, regionCoverage, runDuration, sampleRun } from '../src/lib/slab';

const CAP = '0x1a72f7314297B0b8f6808A9248969A8108F49890';
const LEDGER = '0xD8382719b8fF90eE3Dd521B9d7c5dc23E8e4EAca';

describe('wallet sequence', () => {
  it('validates addresses and computes EIP-55 casing', () => {
    expect(parseAddress(CAP)).toMatchObject({ ok: true, checksum: CAP });
    expect(parseAddress(CAP.toLowerCase())).toMatchObject({ ok: true, checksum: CAP, fixedCase: true });
    expect(parseAddress('0x' + CAP.slice(2).toUpperCase())).toMatchObject({ ok: true, checksum: CAP });
    expect(parseAddress(LEDGER)).toMatchObject({ ok: true, checksum: LEDGER });
    expect(parseAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toMatchObject({ ok: true }); // EIP-55 test vector
    expect(parseAddress('0x1A72f7314297B0b8f6808A9248969A8108F49890').ok).toBe(false); // bad checksum
    expect(parseAddress('0x1234').ok).toBe(false);
    expect(parseAddress('1a72f7314297b0b8f6808a9248969a8108f49890').ok).toBe(false);
    expect(parseAddress('0xZZ72f7314297b0b8f6808a9248969a8108f49890').ok).toBe(false);
  });

  it('is deterministic and case-insensitive on input', () => {
    for (const key of ['raw', 'hashed'] as const) {
      for (const v of ['v1', 'v2'] as const) {
      const a = walletSequence(CAP, key, v), b = walletSequence(CAP.toLowerCase(), key, v);
      const strip = (w: typeof a) => JSON.stringify({ ...w, steps: w.steps.map(({ id: _, ...s }) => s) });
      expect(strip(a)).toBe(strip(b));
      expect(a.decoded.length).toBe(v === 'v1' ? 38 : 19);
      expect(a.source.length).toBe(40);
    } }
    expect(sourceChars(CAP, 'raw')).toBe(CAP.slice(2));
    expect(sourceChars(CAP, 'hashed')).not.toBe(sourceChars(CAP, 'raw'));
    expect(walletSequence(CAP, 'raw', 'v1').name).toBe('Wallet 0x1a72…9890 (raw v1)');
    expect(walletSequence(CAP, 'raw', 'v2').name).toBe('Wallet 0x1a72…9890 (raw v2)');
    expect(walletSequence(CAP, 'raw').name).toBe('Wallet 0x1a72…9890 (raw v3)');
  });

  it('keeps the centre spot inside the safe bounds', () => {
    for (const addr of [CAP, LEDGER, '0x0000000000000000000000000000000000000000', '0xffffffffffffffffffffffffffffffffffffffff'])
      for (const key of ['raw', 'hashed'] as const) {
        const w = walletSequence(addr, key, 'v1');
        const b = walletBounds(w.optics);
        const s = sampleRun({ name: '', steps: w.steps, optics: { kind: 'none', distance: 0, prismAngle: 0 }, multiplier: 1, circleDia: 0, circleRev: 4, spotDia: 1.75 });
        for (let k = 0; k < s.n; k++) {
          expect(Math.abs(s.xs[k])).toBeLessThanOrEqual(b.x + 5.01 + 3);
          expect(Math.abs(s.ys[k])).toBeLessThanOrEqual(b.y + 5.01 + 3);
          expect(Math.abs(s.rot[k])).toBeLessThanOrEqual(b.rot + 30.01);
        }
      }
  });
});

describe('wallet key v2 (circle-heavy)', () => {
  it('uses rings, circles, arcs and spirals with sizes from small to large, and stays on the face', () => {
    let dias: number[] = [];
    let kinds = new Set<string>();
    for (const addr of [CAP, LEDGER, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'])
      for (const key of ['raw', 'hashed'] as const) {
        const w = walletSequence(addr, key, 'v2');
        for (const st of w.steps) {
          if (st.ring) { dias.push(st.ring); kinds.add('ring'); }
          if (st.action === 'circle' || st.action === 'spiral') { dias.push(st.amount); kinds.add(st.action); }
          if (st.action === 'cw' || st.action === 'ccw') kinds.add('arc');
        }
        const b = walletBounds(w.optics);
        const s = sampleRun({ name: '', steps: w.steps, optics: { kind: 'none', distance: 0, prismAngle: 0 }, multiplier: 1, circleDia: 0, circleRev: 4, spotDia: 1.75 });
        for (let k = 0; k < s.n; k++) {
          expect(Math.abs(s.xs[k])).toBeLessThanOrEqual(b.x + 1.5);
          expect(Math.abs(s.ys[k])).toBeLessThanOrEqual(b.y + 1.5);
        }
      }
    expect([...kinds].sort()).toEqual(['arc', 'circle', 'ring', 'spiral']);
    expect(Math.min(...dias)).toBeLessThanOrEqual(3);
    expect(Math.max(...dias)).toBeGreaterThanOrEqual(14);
  });
});

describe('wallet key v3 (whole slab, 10-30 min)', () => {
  const strip = (w: ReturnType<typeof walletSequence>) => JSON.stringify({ ...w, steps: w.steps.map(({ id: _, ...s }) => s) });
  it('is deterministic', () => {
    for (const key of ['raw', 'hashed'] as const) expect(strip(walletSequence(CAP, key, 'v3'))).toBe(strip(walletSequence(CAP.toLowerCase(), key, 'v3')));
    expect(strip(walletSequence(CAP, 'raw', 'v3'))).not.toBe(strip(walletSequence(CAP, 'hashed', 'v3')));
  });
  it('runs 10-30 min, marks >= 80% of the 6x3 regions, and has >= 200 passes', () => {
    for (const addr of [CAP, LEDGER, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xCF1ac98565DA846E8263604b49C1276Ed78A0981'])
      for (const key of ['raw', 'hashed'] as const) {
        const w = walletSequence(addr, key, 'v3');
        const run = { name: '', steps: w.steps, optics: w.optics, multiplier: 1, circleDia: 0, circleRev: 4, spotDia: 1.75 };
        const min = runDuration(run) / 60;
        expect(min, `${addr} ${key}`).toBeGreaterThanOrEqual(10);
        expect(min, `${addr} ${key}`).toBeLessThanOrEqual(30);
        expect(w.rows!, `${addr} ${key}`).toBeGreaterThanOrEqual(200);
        const cov = regionCoverage(gridForRuns([run]), 6, 3);
        expect(cov.frac, `${addr} ${key}`).toBeGreaterThanOrEqual(0.8);
      }
  }, 60000);
});
