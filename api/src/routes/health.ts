import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (request, reply) => {
    try {
      await app.db.query('SELECT 1');
      return { status: 'ok', postgres: 'up' };
    } catch (err) {
      request.log.error({ err }, 'postgres health check failed');
      return reply.code(503).send({
        error: 'postgres_unavailable',
        message: 'postgres is unreachable',
        requestId: request.id,
      });
    }
  });
}
