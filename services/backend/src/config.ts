import { z } from 'zod';

/**
 * Configuration comes from the environment and is validated once at start-up.
 *
 * A service that discovers a missing setting on the first request has already accepted
 * traffic it cannot serve. Failing here means a bad deployment never reaches a player.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  PUBLIC_BASE_URL: z.string().url(),
  // Seals the pending nonce at rest (ADR 0010). The companion has to be handed the nonce
  // itself, so the digest alone no longer suffices — but the key lives here and not in the
  // database, which keeps the property that a dump cannot be replayed against a live gate.
  NONCE_SEAL_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'NONCE_SEAL_KEY must be 32 bytes as 64 hex characters'),
  // Only meaningful behind a proxy under our control. Left on by accident it lets a client
  // choose the address the relay check compares against (design document 5.4).
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return result.data;
}
