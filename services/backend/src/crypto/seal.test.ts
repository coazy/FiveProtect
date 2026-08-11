import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { equalSecrets, open, seal, sealKey } from './seal.js';

const KEY = sealKey('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
const NONCE = 'a'.repeat(64);

describe('nonce sealing', () => {
  it('round-trips a nonce', () => {
    expect(open(KEY, seal(KEY, NONCE))).toBe(NONCE);
  });

  it('produces a different ciphertext every time', () => {
    // A deterministic ciphertext would tell anyone with read access to the table which two
    // sessions were issued the same nonce — and, worse, make one sealed value reusable.
    const first = seal(KEY, NONCE);
    const second = seal(KEY, NONCE);
    expect(first.equals(second)).toBe(false);
  });

  it('refuses a value sealed under a different key', () => {
    const other = sealKey(randomBytes(32).toString('hex'));
    expect(open(other, seal(KEY, NONCE))).toBeNull();
  });

  it('refuses a tampered ciphertext rather than returning something plausible', () => {
    // The reason for GCM over CBC. Without the tag a flipped byte would decrypt to a nonce
    // nobody issued, and the gate would compare a digest against garbage.
    const sealed = seal(KEY, NONCE);
    const last = sealed.length - 1;
    sealed.writeUInt8(sealed.readUInt8(last) ^ 0x01, last);
    expect(open(KEY, sealed)).toBeNull();
  });

  it('refuses a truncated value', () => {
    for (const length of [0, 12, 27]) {
      expect(open(KEY, seal(KEY, NONCE).subarray(0, length))).toBeNull();
    }
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => sealKey('abcd')).toThrow(/32 bytes/);
  });
});

describe('equalSecrets', () => {
  it('matches identical values and nothing else', () => {
    expect(equalSecrets(NONCE, NONCE)).toBe(true);
    expect(equalSecrets(NONCE, 'b'.repeat(64))).toBe(false);
    expect(equalSecrets(NONCE, NONCE.slice(0, 63))).toBe(false);
    expect(equalSecrets('', '')).toBe(true);
  });
});
