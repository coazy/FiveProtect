import {
  AttestationRequest,
  CompanionOutcomeRequest,
  CompanionPollRequest,
  HeartbeatRequest,
  PROTOCOL_VERSION,
  type AttestationAck,
  type CompanionPollResponse,
  type HeartbeatResponse,
} from '@fiveprotect/protocol';
import type { FastifyInstance } from 'fastify';

import { clientIp, type AppContext } from '../app.js';
import { ApiError } from '../errors.js';
import { normaliseIp } from '../attestation/policy.js';
import { TIMING, processAttestation, toVerdict } from '../attestation/service.js';
import { open, sealKey } from '../crypto/seal.js';
import * as sessions from '../repositories/sessions.js';

/** How often the companion long poll re-reads the pending sessions for an address. */
const PENDING_POLL_INTERVAL_MS = 250;

/**
 * Endpoints the companion calls.
 *
 * Neither carries a credential. The companion is untrusted by construction (ADR 0004), so
 * there is nothing to authenticate it with that an attacker on the same machine would not
 * also hold. What binds a request to a session is the nonce — single use, 30 seconds — and
 * the session id, which authorises nothing beyond keeping its own session alive.
 */
export function registerAttestRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db } = context;

  /**
   * Step 4, replacing the localhost hop: the companion collects the nonce meant for it.
   *
   * ADR 0010. FiveM does not run client resources while a player is held in a connect
   * deferral, so nothing on the game client can carry the nonce at the moment the gate
   * needs it. The companion asks here instead, and the only thing that selects an answer is
   * the address the request came from — which the caller cannot choose.
   *
   * Unauthenticated for the same reason `/v1/attest` is: there is no secret the companion
   * could hold that an attacker on the same machine would not also hold.
   */
  app.post('/v1/companion/pending', async (request, reply) => {
    const parsed = CompanionPollRequest.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.badRequest('malformed_request', 'the poll did not match the protocol');
    }

    const origin = normaliseIp(clientIp(request));
    const key = sealKey(context.config.NONCE_SEAL_KEY);
    const deadline = Date.now() + Math.min(parsed.data.waitSeconds, 30) * 1000;

    for (;;) {
      const pending = await sessions.findPendingByGameIp(db, origin);

      // Two players behind one NAT produce two pending sessions from one address. Picking
      // either would let a cheater's session be answered by a clean machine's snapshot, so
      // the ambiguity is refused and the connect falls back to the timeout path.
      if (pending.length > 1) {
        request.log.warn({ origin, count: pending.length }, 'pending nonce is ambiguous');
        throw ApiError.conflict(
          'origin_ambiguous',
          'more than one connect is pending from this address',
        );
      }

      const session = pending[0];
      if (session !== undefined && session.nonceSealed !== null) {
        const nonce = open(key, session.nonceSealed);
        if (nonce === null) {
          // Sealed under a key this deployment no longer holds. Nothing the companion can
          // do about it; the session is left to expire.
          request.log.error({ sessionId: session.id }, 'sealed nonce could not be opened');
          throw ApiError.internal();
        }

        request.log.info({ sessionId: session.id, origin }, 'nonce collected by companion');

        const answer: CompanionPollResponse = {
          pending: true,
          nonce,
          serverName: session.serverName,
          policyTier: session.policyTier,
          expiresAt: session.expiresAt.toISOString(),
          protocolVersion: PROTOCOL_VERSION,
        };
        return reply.send(answer);
      }

      if (Date.now() >= deadline) {
        const empty: CompanionPollResponse = { pending: false, protocolVersion: PROTOCOL_VERSION };
        return reply.send(empty);
      }

      await sleep(PENDING_POLL_INTERVAL_MS);
    }
  });

  /**
   * How the attestation this companion filed was judged.
   *
   * ADR 0011 relaxes ADR 0004 here. The rule was that the companion must never learn the
   * verdict, so an attacker could not use it as a local oracle. But the reason and the
   * remediation text are handed to the player by the FiveM connect screen anyway — the
   * secrecy was never real, and its only effect was a companion window claiming everything
   * was fine while the server refused the connection.
   *
   * Bound to a session id the caller already holds. Anyone who has it attested for it.
   */
  app.post('/v1/companion/outcome', async (request, reply) => {
    const parsed = CompanionOutcomeRequest.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.badRequest('malformed_request', 'the request did not match the protocol');
    }

    const deadline = Date.now() + Math.min(parsed.data.waitSeconds, 10) * 1000;

    for (;;) {
      const session = await sessions.findByIdUnscoped(db, parsed.data.sessionId);
      if (session === null) {
        throw ApiError.notFound('session_unknown', 'no such session');
      }

      // The attestation that produced this session came from somewhere. If this request
      // comes from anywhere else, it is not the companion that filed it asking.
      if (
        session.attestationIp !== null &&
        normaliseIp(session.attestationIp) !== normaliseIp(clientIp(request))
      ) {
        throw ApiError.notFound('session_unknown', 'no such session');
      }

      if (session.verdictDecision !== 'pending') {
        return reply.send(toVerdict(session));
      }

      if (Date.now() >= deadline) {
        // Still forming. The resource's own poll is what decides it; the companion simply
        // asked too early and will be told by its next request.
        return reply.status(202).send({
          code: 'verdict_pending',
          message: 'no verdict yet',
          requestId: request.id,
        });
      }

      await sleep(PENDING_POLL_INTERVAL_MS);
    }
  });

  /** Step 6: the companion reports directly, never through the game client. */
  app.post('/v1/attest', async (request, reply) => {
    const parsed = AttestationRequest.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.badRequest(
        'attestation_invalid',
        'the attestation did not match the protocol',
      );
    }

    const outcome = await processAttestation(db, parsed.data, clientIp(request));

    request.log.info(
      {
        tenantId: outcome.session.tenantId,
        sessionId: outcome.session.id,
        decision: outcome.decision,
        reasons: outcome.reasons,
      },
      'attestation evaluated',
    );

    // The acknowledgement carries no judgement. Telling the companion whether it passed
    // would hand an attacker a local oracle to test modifications against.
    const ack: AttestationAck = {
      accepted: true,
      sessionId: outcome.session.id,
      receivedAt: new Date().toISOString(),
      heartbeatIntervalSeconds: TIMING.heartbeatIntervalSeconds,
    };
    return reply.status(202).send(ack);
  });

  /** Keeps a session alive while the player is in game (design document 5.5). */
  app.post('/v1/sessions/heartbeat', async (request, reply) => {
    const parsed = HeartbeatRequest.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.badRequest('malformed_request', 'the heartbeat did not match the protocol');
    }
    const beat = parsed.data;

    const session = await sessions.findByIdUnscoped(db, beat.sessionId);
    if (session === null) {
      throw ApiError.notFound('session_unknown', 'no such session');
    }

    // A build swapped mid-session is exactly what build pinning exists to catch: the
    // companion that attested and the one reporting now are not the same binary.
    const snapshotBuild = await currentBuildHash(db, session.id);
    if (snapshotBuild !== null && snapshotBuild !== beat.companionBuildHash) {
      await sessions.terminateSession(db, session.id, 'companion_outdated');
      request.log.warn(
        { sessionId: session.id },
        'companion build changed mid-session, session terminated',
      );
      return reply.send(terminate('companion_outdated'));
    }

    // The companion says it is going away. Design document 5.5 wants a restart to survive
    // the session and a deliberate exit not to; without this both cost the full interval
    // plus grace, so quitting on purpose bought three and a half minutes without a
    // companion. Killing the process instead still falls back to that timeout, which is
    // the behaviour the grace period exists for.
    if (beat.closing === true) {
      await sessions.terminateSession(db, session.id, 'heartbeat_lost');
      request.log.info({ sessionId: session.id }, 'companion closed, session terminated');
      return reply.send(terminate('heartbeat_lost'));
    }

    if (!beat.gameProcessPresent) {
      await sessions.terminateSession(db, session.id, 'game_process_missing');
      return reply.send(terminate('game_process_missing'));
    }

    const extended = await sessions.recordHeartbeat(db, session.id, TIMING.heartbeatGraceSeconds);
    if (!extended) {
      // The session is no longer one that may be kept alive — already terminated, or never
      // allowed in the first place.
      return reply.send(terminate('heartbeat_lost'));
    }

    const response: HeartbeatResponse = {
      acknowledged: true,
      nextIntervalSeconds: TIMING.heartbeatIntervalSeconds,
      terminate: false,
    };
    return reply.send(response);
  });

  return Promise.resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminate(reason: HeartbeatResponse['terminateReason']): HeartbeatResponse {
  return {
    acknowledged: false,
    nextIntervalSeconds: TIMING.heartbeatIntervalSeconds,
    terminate: true,
    ...(reason === undefined ? {} : { terminateReason: reason }),
  };
}

async function currentBuildHash(db: AppContext['db'], sessionId: string): Promise<string | null> {
  const { rows } = await db.query<{ companionBuildHash: string }>(
    `SELECT companion_build_hash AS "companionBuildHash"
       FROM system_snapshots
      WHERE session_id = $1
      ORDER BY received_at DESC
      LIMIT 1`,
    [sessionId],
  );
  return rows[0]?.companionBuildHash ?? null;
}
