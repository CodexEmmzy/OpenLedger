import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiEnv } from '@openledger/shared';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = loadApiEnv({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
    });
    app = await buildApp(env);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 when Postgres answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', postgres: 'up' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('echoes an incoming request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-fixed-1' },
    });
    expect(res.headers['x-request-id']).toBe('req-fixed-1');
  });
});
