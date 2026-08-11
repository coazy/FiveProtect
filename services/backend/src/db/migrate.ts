import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, type Database } from './pool.js';

/**
 * Finds `migrations/` by walking up from this file.
 *
 * A fixed number of `..` segments would be wrong in one of the two layouts this file runs
 * in: `src/db/` under tsx and `dist/src/db/` after a build. Getting it wrong means `start`
 * fails on a freshly built deployment while `dev` works, which is the worst place for a
 * difference to hide.
 */
function findMigrationsDir(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(directory);

  while (directory !== root) {
    const candidate = join(directory, 'migrations');
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }

  throw new Error('migrations directory not found above ' + fileURLToPath(import.meta.url));
}

const migrationsDir = findMigrationsDir();

/**
 * Forward-only numbered migrations with a ledger table.
 *
 * No down migrations: rolling a schema backwards on a live database is a manual, thought-
 * through operation, and an automated `down` invites treating it as routine. A mistake is
 * corrected by a new migration.
 */
export async function migrate(
  pool: Database,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (row) => row.name,
    ),
  );

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      // Each migration is one transaction: a failure half way through leaves nothing
      // behind, so a rerun starts from a known state.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
      log(`applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${String(error)}`);
    } finally {
      client.release();
    }
  }

  if (ran.length === 0) log('database is up to date');
  return ran;
}

// Entry point for `npm run migrate`.
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(1);
  }
  const pool = createPool(connectionString);
  migrate(pool, (message) => process.stdout.write(`${message}\n`))
    .then(() => pool.end())
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      void pool.end();
      process.exit(1);
    });
}
