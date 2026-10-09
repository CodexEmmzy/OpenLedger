import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiEnv } from '@openledger/shared';
import type { IdentityVerifier } from '../src/auth/oidc.js';
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
    const identityVerifier: IdentityVerifier = async (authorization) => {
      if (authorization !== 'Bearer test-token') {
        throw new Error('invalid test token');
      }
      return { subject: 'integration-user', scopes: new Set(['ledger:read', 'ledger:write']) };
    };
    app = await buildApp(env, { identityVerifier });
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

  it('creates a customer account for the authenticated principal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer test-token' },
      payload: { currency: 'NGN', displayName: 'ops' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      currency: 'NGN',
      displayName: 'ops',
      status: 'active',
    });
    const ownership = await app.db.query(
      'SELECT 1 FROM accounts WHERE id = $1 AND owner_subject = $2',
      [res.json().id, 'integration-user'],
    );
    expect(ownership.rowCount).toBe(1);
  });

  it('rejects account creation without a verified bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      payload: { currency: 'NGN' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
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
