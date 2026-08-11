import { randomUUID } from 'node:crypto';

import { migrate } from '../../db/migrate.js';
import { createPool, type Database } from '../../db/pool.js';
import { hashServerKey } from '../../repositories/tenants.js';
import type { FailMode } from '../../repositories/types.js';
import type { PolicyTier } from '@fiveprotect/protocol';

/**
 * Integration tests run against a real PostgreSQL, or not at all.
 *
 * No in-memory substitute: the two things most worth proving here are that a conditional
 * UPDATE arbitrates concurrent nonce claims and that tenant scoping holds. Both are
 * properties of the database, and a fake would prove only that the fake agrees with itself.
 *
 * CI provides a service container. Locally, point TEST_DATABASE_URL at a scratch database;
 * without it the suite reports itself skipped rather than passing silently.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasDatabase = TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL !== '';

export async function setupDatabase(): Promise<Database> {
  if (!hasDatabase) throw new Error('TEST_DATABASE_URL is not set');
  const pool = createPool(TEST_DATABASE_URL as string);
  await migrate(pool);
  return pool;
}

/** Empties every table between tests, leaving the schema in place. */
export async function truncateAll(db: Database): Promise<void> {
  await db.query(
    'TRUNCATE tenants, game_servers, player_identities, attestation_sessions, ' +
      'system_snapshots, companion_builds RESTART IDENTITY CASCADE',
  );
}

export interface SeededTenant {
  tenantId: string;
  serverId: string;
  serverKey: string;
}

export async function seedTenant(
  db: Database,
  options: { policyTier?: PolicyTier; failMode?: FailMode; name?: string } = {},
): Promise<SeededTenant> {
  const { rows: tenantRows } = await db.query<{ id: string }>(
    `INSERT INTO tenants (name, policy_tier, fail_mode)
          VALUES ($1, $2, $3) RETURNING id`,
    [
      options.name ?? 'Test Tenant',
      options.policyTier ?? 'standard',
      options.failMode ?? 'fail_open',
    ],
  );
  const tenantId = tenantRows[0]?.id;
  if (tenantId === undefined) throw new Error('seedTenant: no tenant row');

  const serverKey = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const { rows: serverRows } = await db.query<{ id: string }>(
    `INSERT INTO game_servers (tenant_id, name, server_key_hash)
          VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, 'Test Server', hashServerKey(serverKey)],
  );
  const serverId = serverRows[0]?.id;
  if (serverId === undefined) throw new Error('seedTenant: no server row');

  return { tenantId, serverId, serverKey };
}

export async function acceptBuild(db: Database, buildHash: string): Promise<void> {
  await db.query(
    `INSERT INTO companion_builds (build_hash, version, accepted)
          VALUES ($1, '0.1.0', true)
     ON CONFLICT (build_hash) DO UPDATE SET accepted = true`,
    [buildHash],
  );
}
