import {
  NONCE_TTL_SECONDS,
  NonceRequest,
  PROTOCOL_VERSION,
  VERDICT_POLL_TIMEOUT_SECONDS,
  type LivenessResponse,
  type NonceResponse,
} from '@fiveprotect/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireServer, type AppContext } from '../app.js';
import { seal, sealKey } from '../crypto/seal.js';
import { ApiError } from '../errors.js';
import { TIMING, timeoutVerdict, toVerdict } from '../attestation/service.js';
import * as sessions from '../repositories/sessions.js';
import { touchServer, upsertPlayer } from '../repositories/tenants.js';

/** How often the long poll re-reads the session. */
const POLL_INTERVAL_MS = 250;

const VerdictQuery = z.object({
  nonce: z.string().length(64),
});

export function registerSessionRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db } = context;

  /**
   * Step 2 of the connect flow: the resource asks for a nonce while the player is deferred.
   */
  app.post('/v1/sessions/nonce', async (request, reply) => {
    const auth = await requireServer(db, request);
    const body = parse(NonceRequest, request.body);

    if (body.serverId !== auth.server.id) {
      // The key identifies the server. A body claiming a different one is either a
      // misconfiguration or an attempt to act as another server of the same tenant.
      throw ApiError.forbidden('server_mismatch', 'the server key does not match serverId');
    }

    const playerIdentityId = await upsertPlayer(db, auth.tenant.id, {
      license: body.player.license,
      ...(body.player.steam === undefined ? {} : { steam: body.player.steam }),
      ...(body.player.discord === undefined ? {} : { discord: body.player.discord }),
    });

    const nonce = sessions.generateNonce();
    const session = await sessions.createSession(db, {
      nonceSealed: seal(sealKey(context.config.NONCE_SEAL_KEY), nonce),
      tenantId: auth.tenant.id,
      gameServerId: auth.server.id,
      playerIdentityId,
      // The address of the game connection, as the FiveM server sees it. The relay check
      // later compares it with where the attestation came from (design document 5.4).
      gameIp: body.player.ip,
      policyTier: auth.tenant.policyTier,
      nonce,
      ttlSeconds: NONCE_TTL_SECONDS,
    });

    await touchServer(db, auth.tenant.id, auth.server.id);

    request.log.info(
      { tenantId: auth.tenant.id, sessionId: session.id, tier: session.policyTier },
      'nonce issued',
    );

    const response: NonceResponse = {
      nonce,
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
      policyTier: session.policyTier,
      backendUrl: context.config.PUBLIC_BASE_URL,
      protocolVersion: PROTOCOL_VERSION,
    };
    return reply.status(201).send(response);
  });

  /**
   * Step 8: the resource pulls the verdict.
   *
   * A pull rather than a push. Nothing is delivered to the resource unsolicited, so there is
   * no inbound path an attacker could feed (design document 5.2).
   *
   * POST with the nonce in the body rather than in the path: a nonce in a URL ends up in
   * access logs, proxy logs and error reports, and it is a bearer secret for its 30 seconds.
   */
  app.post('/v1/sessions/verdict', async (request, reply) => {
    const auth = await requireServer(db, request);
    const { nonce } = parse(VerdictQuery, request.body);

    const deadline = Date.now() + VERDICT_POLL_TIMEOUT_SECONDS * 1000;

    for (;;) {
      const session = await sessions.findByNonce(db, auth.tenant.id, nonce);
      if (session === null) {
        throw ApiError.notFound('session_unknown', 'no session for this nonce');
      }

      if (session.verdictDecision !== 'pending') {
        return reply.send(toVerdict(session));
      }

      if (Date.now() >= deadline) {
        // No attestation arrived. What happens now is the tenant's decision, not ours.
        const verdict = timeoutVerdict(session, auth.tenant.failMode);
        await sessions.recordVerdict(db, auth.tenant.id, session.id, {
          decision: verdict.decision === 'allow' ? 'allow' : 'deny',
          reasons: verdict.reasons,
          requirements: verdict.requirements,
          remediation: verdict.remediation,
          failOpen: verdict.failOpen,
        });

        request.log.warn(
          {
            tenantId: auth.tenant.id,
            sessionId: session.id,
            failMode: auth.tenant.failMode,
            decision: verdict.decision,
          },
          'attestation timed out',
        );
        return reply.send(verdict);
      }

      // Polling rather than LISTEN/NOTIFY. At one query every 250 ms for at most 20 seconds
      // this costs less than holding a dedicated connection per waiting player, and it has
      // no failure mode where a missed notification strands a session.
      await sleep(POLL_INTERVAL_MS);
    }
  });

  /**
   * Whether a player already in game may stay.
   *
   * The session id is not a secret — it identifies a record, it does not authorise anything —
   * so it is fine in the path, unlike the nonce.
   */
  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/liveness',
    async (request, reply) => {
      const auth = await requireServer(db, request);
      const session = await sessions.findById(db, auth.tenant.id, request.params.sessionId);
      if (session === null) {
        throw ApiError.notFound('session_unknown', 'no such session');
      }

      const response = buildLiveness(session);

      if (response.shouldKick && session.state !== 'terminated') {
        await sessions.terminateSession(db, session.id, response.reason ?? 'heartbeat_lost');
        request.log.info(
          { tenantId: auth.tenant.id, sessionId: session.id },
          'session terminated, heartbeat lost',
        );
      }

      return reply.send(response);
    },
  );

  return Promise.resolve();
}

/**
 * Turns heartbeat timestamps into a decision the resource can act on.
 *
 * The grace period is what keeps a companion restart or a short network drop from throwing
 * a player out (design document 5.5). Deliberately exported and pure so the boundary cases
 * are unit tests rather than a stopwatch.
 */
export function buildLiveness(
  session: {
    id: string;
    state: string;
    lastHeartbeatAt: Date | null;
    graceExpiresAt: Date | null;
    terminationReason: string | null;
  },
  now: Date = new Date(),
): LivenessResponse {
  const base = {
    sessionId: session.id,
    state: session.state as LivenessResponse['state'],
  };

  if (session.state === 'terminated') {
    return {
      ...base,
      shouldKick: true,
      reason: (session.terminationReason as LivenessResponse['reason']) ?? 'heartbeat_lost',
      ...(session.lastHeartbeatAt === null
        ? {}
        : { lastHeartbeatAt: session.lastHeartbeatAt.toISOString() }),
    };
  }

  if (session.state !== 'active' || session.lastHeartbeatAt === null) {
    return { ...base, shouldKick: false };
  }

  const silentFor = (now.getTime() - session.lastHeartbeatAt.getTime()) / 1000;
  const withinInterval = silentFor <= TIMING.heartbeatIntervalSeconds;

  if (withinInterval) {
    return {
      ...base,
      shouldKick: false,
      lastHeartbeatAt: session.lastHeartbeatAt.toISOString(),
    };
  }

  // The heartbeat is late. The player stays, sees a warning, and is only removed once the
  // grace period has also run out.
  const graceEnds = new Date(
    session.lastHeartbeatAt.getTime() +
      (TIMING.heartbeatIntervalSeconds + TIMING.heartbeatGraceSeconds) * 1000,
  );

  return {
    ...base,
    lastHeartbeatAt: session.lastHeartbeatAt.toISOString(),
    graceExpiresAt: graceEnds.toISOString(),
    shouldKick: now >= graceEnds,
    ...(now >= graceEnds ? { reason: 'heartbeat_lost' as const } : {}),
  };
}

function parse<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    throw ApiError.badRequest('malformed_request', 'the request body did not match the protocol');
  }
  return result.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
