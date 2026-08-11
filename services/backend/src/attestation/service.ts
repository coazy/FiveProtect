import {
  HEARTBEAT_GRACE_SECONDS,
  HEARTBEAT_INTERVAL_SECONDS,
  NONCE_TTL_SECONDS,
  type AttestationRequest,
  type DenyReason,
  type RequirementResult,
  type Verdict,
} from '@fiveprotect/protocol';

import type { Database } from '../db/pool.js';
import { ApiError } from '../errors.js';
import * as sessions from '../repositories/sessions.js';
import { isBuildAccepted } from '../repositories/tenants.js';
import type { SessionRow } from '../repositories/types.js';
import { evaluatePolicy } from './policy.js';
import { buildRemediation } from './remediation.js';

/**
 * The one place in the system that decides `allow` or `deny`.
 *
 * ADR 0004: no other component produces a verdict, and nothing a client sends is treated as
 * one. The companion delivers facts; the decision is made here from those facts and the
 * tenant's policy.
 */

export interface AttestationOutcome {
  session: SessionRow;
  decision: 'allow' | 'deny';
  reasons: DenyReason[];
  requirements: RequirementResult[];
  remediation: string | undefined;
}

export async function processAttestation(
  db: Database,
  request: AttestationRequest,
  attestationIp: string,
): Promise<AttestationOutcome> {
  const claim = await sessions.consumeNonce(db, request.nonce, attestationIp);

  switch (claim.outcome) {
    case 'unknown':
      // The same answer for an unknown and an expired nonce would be friendlier to debug
      // and friendlier to probe. An attacker learns nothing about which nonces exist.
      throw ApiError.notFound('nonce_unknown', 'no session for this nonce');
    case 'expired':
      throw ApiError.conflict('nonce_expired', 'the nonce is no longer valid');
    case 'already_consumed':
      throw ApiError.conflict('nonce_reused', 'the nonce was already used');
    case 'consumed':
      break;
  }

  const session = claim.session;

  // Stored before evaluation: the evidence is worth keeping whatever the verdict, and a
  // failure in the policy code must not lose the only record of what the machine looked
  // like.
  await sessions.storeSnapshot(db, session.tenantId, session.id, request.snapshot);

  const buildAccepted = await isBuildAccepted(db, request.snapshot.companionBuildHash);

  const outcome = evaluatePolicy({
    tier: session.policyTier,
    snapshot: request.snapshot,
    gameIp: session.gameIp,
    attestationIp,
    buildAccepted,
  });

  const remediation = buildRemediation(outcome.reasons, outcome.requirements);

  await sessions.recordVerdict(db, session.tenantId, session.id, {
    decision: outcome.decision,
    reasons: outcome.reasons,
    requirements: outcome.requirements,
    remediation,
    failOpen: false,
  });

  return {
    session,
    decision: outcome.decision,
    reasons: outcome.reasons,
    requirements: outcome.requirements,
    remediation,
  };
}

/** Builds the wire verdict from a stored session. */
export function toVerdict(session: SessionRow): Verdict {
  const base = {
    decision: session.verdictDecision,
    sessionId: session.id,
    reasons: session.verdictReasons as DenyReason[],
    requirements: (session.verdictRequirements ?? []) as RequirementResult[],
    policyTier: session.policyTier,
    evaluatedAt: (session.evaluatedAt ?? session.issuedAt).toISOString(),
    failOpen: session.failOpen,
  };
  return session.verdictRemediation === null
    ? base
    : { ...base, remediation: session.verdictRemediation };
}

/**
 * The verdict for a session that never produced an attestation.
 *
 * Two shapes, chosen by the tenant's fail mode (ADR 0005). Both are marked so the reason a
 * player got in — or did not — is visible afterwards rather than inferred.
 */
export function timeoutVerdict(
  session: SessionRow,
  failMode: 'fail_open' | 'fail_closed',
): Verdict {
  const requirements: RequirementResult[] = [
    {
      requirement: 'companion_attested',
      status: 'fail',
      detail: 'keine Attestation innerhalb des Zeitfensters',
    },
  ];

  if (failMode === 'fail_open') {
    return {
      decision: 'allow',
      sessionId: session.id,
      reasons: [],
      requirements,
      policyTier: session.policyTier,
      evaluatedAt: new Date().toISOString(),
      // Marked, not silent: ADR 0005 requires that sessions admitted this way stay
      // identifiable.
      failOpen: true,
    };
  }

  return {
    decision: 'deny',
    sessionId: session.id,
    reasons: ['companion_timeout'],
    requirements,
    remediation:
      buildRemediation(['companion_timeout'], requirements) ??
      'FiveProtect hat nicht rechtzeitig geantwortet.',
    policyTier: session.policyTier,
    evaluatedAt: new Date().toISOString(),
    failOpen: false,
  };
}

export const TIMING = {
  nonceTtlSeconds: NONCE_TTL_SECONDS,
  heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
  heartbeatGraceSeconds: HEARTBEAT_GRACE_SECONDS,
} as const;
