import pg from 'pg';
import { createLogger, loadWorkerEnv } from '@openledger/shared';

const env = loadWorkerEnv();
const logger = createLogger(env);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

async function tick(): Promise<void> {
  await pool.query('SELECT 1');
  logger.info({ requestId: 'worker-heartbeat' }, 'worker heartbeat');
}

await tick();

const timer = setInterval(() => {
  void tick().catch((err: unknown) => {
    logger.error({ err, requestId: 'worker-heartbeat' }, 'worker tick failed');
  });
}, env.WORKER_INTERVAL_MS);

const shutdown = async (signal: string) => {
  logger.info({ signal, requestId: 'worker-shutdown' }, 'shutting down worker');
  clearInterval(timer);
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
