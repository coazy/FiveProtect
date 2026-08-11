import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sealing for the pending nonce.
 *
 * ADR 0010 forces the backend to hand the nonce back out rather than only compare a digest
 * against it, because the companion has no other way to learn it. Storing it plainly would
 * give up the property `nonce_hash` exists for: a dump of `attestation_sessions` on its own
 * must not be replayable against a live gate.
 *
 * So it is sealed with AES-256-GCM under a key that lives in the environment. The database
 * holds the ciphertext, the deployment holds the key, and neither alone is enough. GCM
 * rather than CBC because the tag makes a tampered row fail loudly instead of decrypting to
 * a nonce nobody issued.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Reads the configured key. Throws rather than accept a key of the wrong size. */
export function sealKey(hex: string): Buffer {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(`NONCE_SEAL_KEY must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

/** Layout is `iv || tag || ciphertext`, all fixed width but the last. */
export function seal(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/**
 * Opens a sealed value, or returns null.
 *
 * Null covers every failure the caller can do nothing about — a truncated row, a value
 * sealed under a key that has since been rotated, a tampered ciphertext. All of them mean
 * the same thing at the call site: this session cannot be delivered, let it expire.
 */
export function open(key: Buffer, sealed: Buffer): string | null {
  if (sealed.length <= IV_BYTES + TAG_BYTES) return null;

  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison of two hex strings of equal length.
 *
 * Used where a nonce read back out of the seal is compared against one supplied by a caller.
 * `===` on secrets leaks their prefix through timing; the cost of doing it properly is one
 * function call.
 */
export function equalSecrets(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
