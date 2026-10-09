import fp from 'fastify-plugin';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    db: pg.Pool;
  }
}

export default fp(async function postgresPlugin(
  app: FastifyInstance,
  opts: { databaseUrl: string },
) {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl });
  app.decorate('db', pool);
  app.addHook('onClose', async () => {
    await pool.end();
  });
});
