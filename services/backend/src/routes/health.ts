import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../app.js';

export function registerHealthRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  // Liveness: is the process up. Deliberately touches nothing, so a database blip does not
  // get the container restarted while it is still able to serve fail-open traffic.
  app.get('/health', () => ({ status: 'ok' }));

  // Readiness: can this instance serve requests. Checked by the load balancer.
  app.get('/ready', async (_request, reply) => {
    try {
      await context.db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'database_unavailable' });
    }
  });

  return Promise.resolve();
}
