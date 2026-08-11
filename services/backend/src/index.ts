import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { expireStaleSessions } from './repositories/sessions.js';

/** How often stale pending sessions are swept. Housekeeping, not enforcement. */
const SWEEP_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL);

  // Migrations run at start-up. With a single instance this is the simplest correct thing;
  // when a second instance appears this moves into a release step, because two processes
  // racing on the same migration is a problem waiting to happen.
  await migrate(db, (message) => process.stdout.write(`migrate: ${message}\n`));

  const app = await buildApp({ config, db });

  const sweep = setInterval(() => {
    expireStaleSessions(db).catch((error: unknown) => {
      app.log.error({ err: error }, 'session sweep failed');
    });
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(sweep);
    // Closing Fastify first lets in-flight long polls finish rather than dropping a player
    // mid-connect.
    await app.close();
    await db.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(`backend failed to start: ${String(error)}\n`);
  process.exit(1);
});
