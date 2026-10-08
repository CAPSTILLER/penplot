import { describe, expect, it } from 'vitest';
import { parseAddress, sourceChars, walletBounds, walletSequence } from '../src/lib/wallet';
import { sampleRun } from '../src/lib/slab';

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
      const a = walletSequence(CAP, key), b = walletSequence(CAP.toLowerCase(), key);
      const strip = (w: typeof a) => JSON.stringify({ ...w, steps: w.steps.map(({ id: _, ...s }) => s) });
      expect(strip(a)).toBe(strip(b));
      expect(a.decoded.length).toBe(38);
      expect(a.source.length).toBe(40);
    }
    expect(sourceChars(CAP, 'raw')).toBe(CAP.slice(2));
    expect(sourceChars(CAP, 'hashed')).not.toBe(sourceChars(CAP, 'raw'));
    expect(walletSequence(CAP, 'raw').name).toBe('Wallet 0x1a72…9890 (raw)');
  });

  it('keeps the centre spot inside the safe bounds', () => {
    for (const addr of [CAP, LEDGER, '0x0000000000000000000000000000000000000000', '0xffffffffffffffffffffffffffffffffffffffff'])
      for (const key of ['raw', 'hashed'] as const) {
        const w = walletSequence(addr, key);
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
