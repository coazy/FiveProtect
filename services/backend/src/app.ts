import { randomUUID } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { Config } from './config.js';
import type { Database } from './db/pool.js';
import { ApiError } from './errors.js';
import { authenticateServerKey, type AuthenticatedServer } from './repositories/tenants.js';
import { registerAttestRoutes } from './routes/attest.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSessionRoutes } from './routes/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireServer`; absent on routes the companion calls. */
    auth?: AuthenticatedServer;
  }
}

export interface AppContext {
  config: Config;
  db: Database;
}

export async function buildApp(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: context.config.LOG_LEVEL,
      redact: {
        // The nonce is a bearer secret and the server key is a credential. Neither belongs
        // in a log line that will be shipped somewhere and kept.
        paths: ['req.headers.authorization', 'req.body.nonce', 'req.body.player'],
        censor: '[redacted]',
      },
    },
    genReqId: () => randomUUID(),
    trustProxy: context.config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });

  await app.register(rateLimit, {
    // Generous by design: a busy server can legitimately produce a burst of connects. The
    // limit is here to blunt a flood, not to shape normal traffic.
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (request) => clientIp(request),
  });

  app.decorate('appContext', context);

  app.setErrorHandler((raw: unknown, request, reply) => {
    if (raw instanceof ApiError) {
      request.log.info(
        { code: raw.code, status: raw.status, path: request.url },
        'request refused',
      );
      return reply.status(raw.status).send(raw.toPayload(request.id));
    }

    // Fastify types the handler's first argument as FastifyError, but a route can throw
    // anything at all. Narrowing here rather than trusting the declared type keeps a thrown
    // string from taking the process down inside the error handler itself.
    const error = raw as { validation?: unknown; statusCode?: number } & Error;

    if (error.validation !== undefined || error.statusCode === 400) {
      request.log.info({ path: request.url }, 'malformed request');
      return reply.status(400).send({
        code: 'malformed_request',
        message: 'the request body did not match the protocol',
        requestId: request.id,
      });
    }

    if (error.statusCode === 429) {
      return reply
        .status(429)
        .send({ code: 'rate_limited', message: 'too many requests', requestId: request.id });
    }

    // Anything unhandled is a defect. It is logged in full and answered with nothing, so a
    // stack trace never leaves the service.
    request.log.error({ err: error, path: request.url }, 'unhandled error');
    return reply.status(500).send({
      code: 'internal_error',
      message: 'internal error',
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      code: 'not_found',
      message: 'no such endpoint',
      requestId: request.id,
    }),
  );

  await registerHealthRoutes(app, context);
  await registerSessionRoutes(app, context);
  await registerAttestRoutes(app, context);

  return app;
}

/**
 * The address the request came from.
 *
 * With `TRUST_PROXY` off this is the socket address, which a client cannot forge. With it
 * on, Fastify resolves `X-Forwarded-For` — correct behind a proxy under our control, and a
 * hole anywhere else, which is why it defaults to off and is documented as such.
 */
export function clientIp(request: FastifyRequest): string {
  return request.ip;
}

/**
 * Authenticates a FiveM server and attaches its tenant to the request.
 *
 * The tenant comes from the key, never from the body. A body-supplied tenant id would let a
 * leaked key from one customer reach another customer's data.
 */
export async function requireServer(
  db: Database,
  request: FastifyRequest,
): Promise<AuthenticatedServer> {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized();
  }

  const auth = await authenticateServerKey(db, header.slice('Bearer '.length).trim());
  if (auth === null) throw ApiError.unauthorized();

  if (auth.tenant.licenseStatus !== 'active') {
    throw ApiError.forbidden(
      'license_inactive',
      `the license for this tenant is ${auth.tenant.licenseStatus}`,
    );
  }

  request.auth = auth;
  return auth;
}
