import { createHash, randomBytes } from 'node:crypto';

import type { PolicyTier, RequirementResult, SystemSnapshot } from '@fiveprotect/protocol';

import type { Database, Queryable } from '../db/pool.js';
import { SESSION_COLUMNS, type SessionRow } from './types.js';

/** 32 random bytes, hex encoded — the shape the protocol declares. */
export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The nonce is stored as a digest.
 *
 * It is a bearer secret in transit: whoever holds it can attest for that session. Keeping
 * only the digest means a dump of this table cannot be replayed against a live gate.
 */
export function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

export interface CreateSessionInput {
  tenantId: string;
  gameServerId: string;
  playerIdentityId: string;
  gameIp: string;
  policyTier: PolicyTier;
  nonce: string;
  ttlSeconds: number;
  /**
   * The nonce sealed under the deployment key, for delivery to the companion (ADR 0010).
   *
   * Separate from the digest rather than replacing it: the digest is what a lookup matches
   * on, and keeping it means the hot path never has to decrypt anything.
   */
  nonceSealed: Buffer;
}

export async function createSession(db: Queryable, input: CreateSessionInput): Promise<SessionRow> {
  const { rows } = await db.query<SessionRow>(
    `INSERT INTO attestation_sessions
            (tenant_id, game_server_id, player_identity_id, nonce_hash, nonce_sealed, game_ip,
             policy_tier, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
     RETURNING ${SESSION_COLUMNS}`,
    [
      input.tenantId,
      input.gameServerId,
      input.playerIdentityId,
      hashNonce(input.nonce),
      input.nonceSealed,
      input.gameIp,
      input.policyTier,
      input.ttlSeconds,
    ],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('createSession returned no row');
  return row;
}

export type ConsumeResult =
  | { outcome: 'consumed'; session: SessionRow }
  | { outcome: 'unknown' }
  | { outcome: 'expired'; session: SessionRow }
  | { outcome: 'already_consumed'; session: SessionRow };

/**
 * Claims a nonce for exactly one attestation.
 *
 * The claim is a single conditional UPDATE rather than a read followed by a write. Two
 * attestations arriving at the same instant would both pass a prior `SELECT`; here the
 * second one finds no row to update, because the row it wants no longer matches
 * `consumed_at IS NULL`. The database does the arbitration, not the application.
 */
export async function consumeNonce(
  db: Queryable,
  nonce: string,
  attestationIp: string,
): Promise<ConsumeResult> {
  const digest = hashNonce(nonce);

  const claimed = await db.query<SessionRow>(
    // `nonce_sealed` is cleared in the same statement that claims the row. The sealed copy
    // exists only so the companion can be handed the nonce while the session is pending;
    // once it has been used there is nothing left for it to unlock.
    `UPDATE attestation_sessions
        SET consumed_at    = now(),
            attested_at    = now(),
            attestation_ip = $2,
            nonce_sealed   = NULL,
            state          = 'attested'
      WHERE nonce_hash  = $1
        AND consumed_at IS NULL
        AND expires_at  > now()
      RETURNING ${SESSION_COLUMNS}`,
    [digest, attestationIp],
  );

  const session = claimed.rows[0];
  if (session !== undefined) return { outcome: 'consumed', session };

  // Nothing was claimed. Read the row to tell the three cases apart, which matters for the
  // audit trail even though the caller is told the same thing either way.
  const existing = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM attestation_sessions WHERE nonce_hash = $1`,
    [digest],
  );

  const row = existing.rows[0];
  if (row === undefined) return { outcome: 'unknown' };
  if (row.consumedAt !== null) return { outcome: 'already_consumed', session: row };
  return { outcome: 'expired', session: row };
}

export interface VerdictUpdate {
  decision: 'allow' | 'deny';
  reasons: string[];
  requirements: RequirementResult[];
  remediation: string | undefined;
  failOpen: boolean;
}

export async function recordVerdict(
  db: Queryable,
  tenantId: string,
  sessionId: string,
  verdict: VerdictUpdate,
): Promise<void> {
  await db.query(
    // $3 is pinned to text and cast where an enum is needed. Without the pin PostgreSQL
    // deduces the enum from `verdict_decision = $3` and then refuses `$3 = 'allow'` with
    // "inconsistent types deduced for parameter $3" — a runtime error the type system
    // cannot see, which is why the integration tests exist.
    `UPDATE attestation_sessions
        SET verdict_decision     = ($3::text)::verdict_decision,
            verdict_reasons      = $4,
            verdict_requirements = $5::jsonb,
            verdict_remediation  = $6,
            fail_open            = $7,
            evaluated_at         = now(),
            state                = CASE WHEN $3::text = 'allow' THEN 'active'::session_state
                                        ELSE 'terminated'::session_state END,
            last_heartbeat_at    = CASE WHEN $3::text = 'allow' THEN now()
                                        ELSE last_heartbeat_at END
      WHERE id = $1 AND tenant_id = $2`,
    [
      sessionId,
      tenantId,
      verdict.decision,
      verdict.reasons,
      JSON.stringify(verdict.requirements),
      verdict.remediation ?? null,
      verdict.failOpen,
    ],
  );
}

export async function storeSnapshot(
  db: Queryable,
  tenantId: string,
  sessionId: string,
  snapshot: SystemSnapshot,
): Promise<void> {
  await db.query(
    `INSERT INTO system_snapshots
            (tenant_id, session_id, companion_build_hash, companion_version, collected_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      tenantId,
      sessionId,
      snapshot.companionBuildHash,
      snapshot.companionVersion,
      snapshot.collectedAt,
      JSON.stringify(snapshot),
    ],
  );
}

/** A pending session as the companion poll needs it. Deliberately not a whole SessionRow. */
export interface PendingSessionRow {
  id: string;
  policyTier: PolicyTier;
  expiresAt: Date;
  nonceSealed: Buffer | null;
  serverName: string;
}

/**
 * Every unconsumed session issued for a game connection from this address.
 *
 * Returns a list rather than one row on purpose. Two players behind one NAT produce two
 * pending sessions from the same address, and the caller has to refuse that case rather
 * than pick one — handing machine A's snapshot to player B's session is how a cheater
 * borrows a clean machine (ADR 0010).
 */
export async function findPendingByGameIp(
  db: Queryable,
  gameIp: string,
): Promise<PendingSessionRow[]> {
  const { rows } = await db.query<PendingSessionRow>(
    `SELECT s.id,
            s.policy_tier  AS "policyTier",
            s.expires_at   AS "expiresAt",
            s.nonce_sealed AS "nonceSealed",
            g.name         AS "serverName"
       FROM attestation_sessions s
       JOIN game_servers g ON g.id = s.game_server_id
      WHERE s.game_ip      = $1::inet
        AND s.consumed_at IS NULL
        AND s.expires_at   > now()
      ORDER BY s.issued_at DESC`,
    [gameIp],
  );
  return rows;
}

export async function findByNonce(
  db: Queryable,
  tenantId: string,
  nonce: string,
): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
       FROM attestation_sessions
      WHERE nonce_hash = $1 AND tenant_id = $2`,
    [hashNonce(nonce), tenantId],
  );
  return rows[0] ?? null;
}

export async function findById(
  db: Queryable,
  tenantId: string,
  sessionId: string,
): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM attestation_sessions WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId],
  );
  return rows[0] ?? null;
}

/** Session lookup for the companion, which has a session id but no tenant context. */
export async function findByIdUnscoped(
  db: Queryable,
  sessionId: string,
): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM attestation_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/**
 * Records a heartbeat and clears any running grace period.
 *
 * Returns false when the session is not one that may be kept alive, which covers a
 * companion still beating for a session that was already terminated.
 */
export async function recordHeartbeat(
  db: Queryable,
  sessionId: string,
  graceSeconds: number,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE attestation_sessions
        SET last_heartbeat_at = now(),
            grace_expires_at  = now() + make_interval(secs => $2)
      WHERE id = $1
        AND state = 'active'`,
    [sessionId, graceSeconds],
  );
  return (rowCount ?? 0) > 0;
}

export async function terminateSession(
  db: Queryable,
  sessionId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE attestation_sessions
        SET state              = 'terminated',
            terminated_at      = now(),
            termination_reason = $2
      WHERE id = $1 AND state <> 'terminated'`,
    [sessionId, reason],
  );
}

/**
 * Marks pending sessions whose nonce ran out.
 *
 * Housekeeping rather than enforcement — `consumeNonce` already refuses an expired nonce.
 * This exists so the state column reflects reality when someone looks at it later.
 */
export async function expireStaleSessions(db: Database): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE attestation_sessions
        SET state = 'expired'
      WHERE state = 'pending' AND expires_at < now()`,
  );
  return rowCount ?? 0;
}
