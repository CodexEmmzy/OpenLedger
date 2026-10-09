import pg from 'pg';
import { createLogger, loadWorkerEnv } from '@openledger/shared';
import { checkLedgerInvariants, processOutboxBatch } from './jobs/outbox.js';

const env = loadWorkerEnv();
const logger = createLogger(env);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

let tickCount = 0;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) {
    return;
  }
  ticking = true;
  try {
    await pool.query('SELECT 1');
    const processed = await processOutboxBatch(pool, env, logger, `worker-${process.pid}`, 10);
    tickCount += 1;
    if (tickCount % 60 === 0) {
      const report = await checkLedgerInvariants(pool);
      if (report.mismatchedAccounts > 0 || report.unbalancedTransactions > 0) {
        logger.error({ report }, 'ledger invariant checker found discrepancies');
      } else {
        logger.info({ report }, 'ledger invariant checker passed');
      }
    }
    logger.info({ requestId: 'worker-heartbeat', outboxProcessed: processed }, 'worker tick');
  } finally {
    ticking = false;
  }
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
