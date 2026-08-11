import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** `packages/protocol`, resolved from this file rather than the working directory. */
export const packageRoot = resolve(here, '..', '..');

export const repoRoot = resolve(packageRoot, '..', '..');

export const generatedRoot = resolve(packageRoot, 'generated');

/**
 * Copies of generated artifacts that have to live somewhere else.
 *
 * A FiveM resource is loaded as a self-contained directory: the server copies it to the
 * host and reads only what is inside it, so it cannot reach into `packages/protocol`. The
 * generator therefore writes the Lua module into the resource as well, and the drift check
 * compares both — a hand-edited copy inside the resource fails CI exactly like a stale one
 * in `generated/`.
 *
 * Keyed by the artifact path relative to `generated/`.
 */
export const EXTRA_DESTINATIONS: Record<string, string[]> = {
  'lua/protocol.lua': [resolve(repoRoot, 'resources', 'fiveprotect', 'shared', 'protocol.lua')],
};
