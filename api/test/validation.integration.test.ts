import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiEnv } from '@openledger/shared';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

describe('OpenAPI request validation', () => {
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

  it('rejects a create-account body missing currency', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('rejects a non-uuid account id', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/accounts/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 501 for a valid create-account payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      payload: { currency: 'NGN', displayName: 'ops' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_implemented');
  });

  it('rejects a transfer without Idempotency-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      payload: {
        sourceAccountId: '11111111-1111-1111-1111-111111111111',
        destinationAccountId: '22222222-2222-2222-2222-222222222222',
        amountMinor: 100,
        currency: 'NGN',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a float amountMinor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { 'idempotency-key': 'key-1' },
      payload: {
        sourceAccountId: '11111111-1111-1111-1111-111111111111',
        destinationAccountId: '22222222-2222-2222-2222-222222222222',
        amountMinor: 10.5,
        currency: 'NGN',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
