import http from 'node:http';
import { createLogger, loadSimulatorEnv } from '@openledger/shared';

const env = loadSimulatorEnv();
const logger = createLogger(env);

const server = http.createServer((req, res) => {
  const requestId = req.headers['x-request-id'] ?? 'simulator';
  if (req.url === '/health' && req.method === 'GET') {
    const body = JSON.stringify({
      status: 'ok',
      role: 'simulator',
      mode: 'placeholder',
      note: 'k6 load profiles land in a later phase; see docs/targets.md',
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': String(requestId),
    });
    res.end(body);
    logger.info({ requestId }, 'simulator health');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', requestId }));
});

server.listen(env.SIMULATOR_PORT, '0.0.0.0', () => {
  logger.info(
    { requestId: 'simulator-listen', port: env.SIMULATOR_PORT },
    'simulator placeholder listening',
  );
});

const shutdown = (signal: string) => {
  logger.info({ signal, requestId: 'simulator-shutdown' }, 'shutting down simulator');
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
