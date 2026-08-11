import { createHash, timingSafeEqual } from 'node:crypto';

import type { Queryable } from '../db/pool.js';
import type { GameServerRow, TenantRow } from './types.js';

/**
 * Server keys are stored as a digest, never in the clear.
 *
 * SHA-256 without a work factor is the right choice here and would be the wrong one for a
 * password: the key is 32 bytes of machine-generated randomness, so there is no dictionary
 * to run and nothing for a slow hash to buy.
 */
export function hashServerKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two digests.
 *
 * The lookup itself is by indexed digest, so this guards the last step rather than the
 * search — but a timing signal on the final compare is free to remove.
 */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface AuthenticatedServer {
  tenant: TenantRow;
  server: GameServerRow;
}

/**
 * Resolves a server key to its tenant and server.
 *
 * The tenant is derived from the key, never taken from the request body. Otherwise a leaked
 * key from one customer could be pointed at another customer's data — the single most
 * damaging failure a multi-tenant service can have.
 */
export async function authenticateServerKey(
  db: Queryable,
  key: string,
): Promise<AuthenticatedServer | null> {
  const digest = hashServerKey(key);
  const { rows } = await db.query<{
    serverId: string;
    serverName: string;
    serverKeyHash: string;
    tenantId: string;
    tenantName: string;
    policyTier: TenantRow['policyTier'];
    failMode: TenantRow['failMode'];
    licenseStatus: TenantRow['licenseStatus'];
    banNetworkEnabled: boolean;
  }>(
    `SELECT s.id            AS "serverId",
            s.name          AS "serverName",
            s.server_key_hash AS "serverKeyHash",
            t.id            AS "tenantId",
            t.name          AS "tenantName",
            t.policy_tier   AS "policyTier",
            t.fail_mode     AS "failMode",
            t.license_status AS "licenseStatus",
            t.ban_network_enabled AS "banNetworkEnabled"
       FROM game_servers s
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.server_key_hash = $1`,
    [digest],
  );

  const row = rows[0];
  if (row === undefined || !digestsMatch(row.serverKeyHash, digest)) return null;

  return {
    tenant: {
      id: row.tenantId,
      name: row.tenantName,
      policyTier: row.policyTier,
      failMode: row.failMode,
      licenseStatus: row.licenseStatus,
      banNetworkEnabled: row.banNetworkEnabled,
    },
    server: { id: row.serverId, tenantId: row.tenantId, name: row.serverName },
  };
}

export async function touchServer(
  db: Queryable,
  tenantId: string,
  serverId: string,
): Promise<void> {
  await db.query('UPDATE game_servers SET last_seen_at = now() WHERE id = $1 AND tenant_id = $2', [
    serverId,
    tenantId,
  ]);
}

/** Upserts the player and returns its identity id, scoped to the tenant. */
export async function upsertPlayer(
  db: Queryable,
  tenantId: string,
  player: { license: string; steam?: string; discord?: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO player_identities (tenant_id, license, steam, discord)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, license) DO UPDATE
            SET steam        = COALESCE(EXCLUDED.steam, player_identities.steam),
                discord      = COALESCE(EXCLUDED.discord, player_identities.discord),
                last_seen_at = now()
      RETURNING id`,
    [tenantId, player.license, player.steam ?? null, player.discord ?? null],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('upsertPlayer returned no row');
  return row.id;
}

/** Whether a companion build hash is on the accepted list (design document 10). */
export async function isBuildAccepted(db: Queryable, buildHash: string): Promise<boolean> {
  const { rows } = await db.query<{ accepted: boolean }>(
    'SELECT accepted FROM companion_builds WHERE build_hash = $1',
    [buildHash],
  );
  return rows[0]?.accepted ?? false;
}
