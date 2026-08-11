import type { PolicyTier, VerdictDecision } from '@fiveprotect/protocol';

export type FailMode = 'fail_open' | 'fail_closed';
export type LicenseStatus = 'active' | 'suspended' | 'expired';
export type SessionState = 'pending' | 'attested' | 'active' | 'expired' | 'terminated';

export interface TenantRow {
  id: string;
  name: string;
  policyTier: PolicyTier;
  failMode: FailMode;
  licenseStatus: LicenseStatus;
  banNetworkEnabled: boolean;
}

export interface GameServerRow {
  id: string;
  tenantId: string;
  name: string;
}

export interface SessionRow {
  id: string;
  tenantId: string;
  gameServerId: string;
  playerIdentityId: string;
  gameIp: string;
  policyTier: PolicyTier;
  state: SessionState;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  attestedAt: Date | null;
  attestationIp: string | null;
  verdictDecision: VerdictDecision;
  verdictReasons: string[];
  verdictRequirements: unknown;
  verdictRemediation: string | null;
  failOpen: boolean;
  evaluatedAt: Date | null;
  lastHeartbeatAt: Date | null;
  graceExpiresAt: Date | null;
  terminatedAt: Date | null;
  terminationReason: string | null;
}

/**
 * The column list every session query selects, aliased to the camelCase field names above.
 *
 * Kept in one place so a new column cannot be added to one query and forgotten in another —
 * a mismatch there surfaces as an undefined field rather than an error.
 */
export const SESSION_COLUMNS = `
  id,
  tenant_id            AS "tenantId",
  game_server_id       AS "gameServerId",
  player_identity_id   AS "playerIdentityId",
  host(game_ip)        AS "gameIp",
  policy_tier          AS "policyTier",
  state,
  issued_at            AS "issuedAt",
  expires_at           AS "expiresAt",
  consumed_at          AS "consumedAt",
  attested_at          AS "attestedAt",
  host(attestation_ip) AS "attestationIp",
  verdict_decision     AS "verdictDecision",
  verdict_reasons      AS "verdictReasons",
  verdict_requirements AS "verdictRequirements",
  verdict_remediation  AS "verdictRemediation",
  fail_open            AS "failOpen",
  evaluated_at         AS "evaluatedAt",
  last_heartbeat_at    AS "lastHeartbeatAt",
  grace_expires_at     AS "graceExpiresAt",
  terminated_at        AS "terminatedAt",
  termination_reason   AS "terminationReason"
`;
