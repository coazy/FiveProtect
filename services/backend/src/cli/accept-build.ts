import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { createPool } from '../db/pool.js';

/**
 * Puts a companion build on the accepted list, or takes it off again.
 *
 * Design document 10: an attestation from a build that is not on this list is refused rather
 * than given a grace period, so a released binary has to be registered before players can
 * use it. Takes the file itself rather than a hash typed by hand — the hash the backend
 * compares against is the one the companion computes from its own bytes, and a transposed
 * character in a 64-character string is a support ticket nobody enjoys.
 *
 *   npm run -w @fiveprotect/backend accept-build -- ./target/release/FiveProtect.exe 0.1.0
 *   npm run -w @fiveprotect/backend accept-build -- --revoke <build hash>
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(1);
  }

  const revoking = args[0] === '--revoke';
  const target = revoking ? args[1] : args[0];
  const version = revoking ? undefined : args[1];

  if (target === undefined) {
    process.stderr.write(
      'usage: accept-build <path to FiveProtect.exe> <version> [--channel stable]\n' +
        '       accept-build --revoke <build hash>\n',
    );
    process.exit(1);
  }

  const pool = createPool(connectionString);
  try {
    if (revoking) {
      // Kept as a row rather than deleted. A revoked build that reconnects should be
      // recognisable in the logs as a known-bad build, not as one nobody has ever seen.
      const { rowCount } = await pool.query(
        'UPDATE companion_builds SET accepted = false WHERE build_hash = $1',
        [target.toLowerCase()],
      );
      process.stdout.write(
        rowCount === 0
          ? `Kein Build mit diesem Hash: ${target}\n`
          : `Build zurückgezogen: ${target}\n`,
      );
      return;
    }

    if (version === undefined) {
      process.stderr.write('the version is required when accepting a build\n');
      process.exit(1);
    }

    const channelIndex = args.indexOf('--channel');
    const channel = channelIndex === -1 ? 'stable' : (args[channelIndex + 1] ?? 'stable');

    const hash = await hashFile(target);

    await pool.query(
      `INSERT INTO companion_builds (build_hash, version, channel, accepted)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (build_hash)
       DO UPDATE SET version = EXCLUDED.version,
                     channel = EXCLUDED.channel,
                     accepted = true`,
      [hash, version, channel],
    );

    process.stdout.write(
      [
        '',
        `Build freigegeben: ${target}`,
        `  Version:  ${version}`,
        `  Kanal:    ${channel}`,
        `  Hash:     ${hash}`,
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

/** SHA-256 of a file, streamed — the same digest the companion computes about itself. */
function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hasher = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(hasher.digest('hex'));
    });
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`accept-build failed: ${String(error)}\n`);
  process.exit(1);
});
