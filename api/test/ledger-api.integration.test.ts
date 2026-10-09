import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiEnv } from '@openledger/shared';
import type { IdentityVerifier } from '../src/auth/oidc.js';
import { buildApp } from '../src/app.js';
import {
  createCustomerAccount,
  postLedgerTransaction,
} from '../src/modules/ledger/ledger-repository.js';
import type { FastifyInstance } from 'fastify';

describe('authenticated ledger API', () => {
  let app: FastifyInstance;
  let clearingAccountId: string;

  beforeAll(async () => {
    const env = loadApiEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error' });
    const identityVerifier: IdentityVerifier = async (authorization) => {
      if (authorization === 'Bearer owner-a') {
        return { subject: 'owner-a', scopes: new Set(['ledger:read', 'ledger:write']) };
      }
      if (authorization === 'Bearer owner-b') {
        return { subject: 'owner-b', scopes: new Set(['ledger:read', 'ledger:write']) };
      }
      throw new Error('invalid token');
    };
    app = await buildApp(env, { identityVerifier });
    const result = await app.db.query<{ id: string }>(
      `SELECT id FROM accounts WHERE account_code = 'provider_clearing_NGN'`,
    );
    const clearing = result.rows[0];
    if (!clearing) {
      throw new Error('NGN provider clearing system account is missing; run migrations first');
    }
    clearingAccountId = clearing.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('posts an authenticated transfer once and replays the committed result', async () => {
    const source = await createCustomerAccount(app.db, {
      currency: 'NGN',
      displayName: 'Owner A source',
      ownerSubject: 'owner-a',
      externalRef: `api-source:${randomUUID()}`,
    });
    const destination = await createCustomerAccount(app.db, {
      currency: 'NGN',
      displayName: 'Owner A destination',
      ownerSubject: 'owner-a',
      externalRef: `api-destination:${randomUUID()}`,
    });
    await postLedgerTransaction(app.db, {
      idempotencyKey: `api-fund:${randomUUID()}`,
      type: 'deposit',
      currency: 'NGN',
      entries: [
        { accountId: clearingAccountId, direction: 'debit', amountMinor: 1000n },
        { accountId: source.id, direction: 'credit', amountMinor: 1000n },
      ],
    });

    const request = {
      method: 'POST' as const,
      url: '/v1/transfers',
      headers: {
        authorization: 'Bearer owner-a',
        'idempotency-key': `api-transfer:${randomUUID()}`,
      },
      payload: {
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        amountMinor: 275,
        currency: 'NGN',
      },
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amountMinor: 275,
      currency: 'NGN',
    });

    const balance = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${source.id}/balance`,
      headers: { authorization: 'Bearer owner-a' },
    });
    expect(balance.statusCode).toBe(200);
    expect(balance.json().amountMinor).toBe(725);

    const history = await app.inject({
      method: 'GET',
      url: `/v1/transfers/${first.json().id}`,
      headers: { authorization: 'Bearer owner-a' },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual(first.json());
  });

  it('does not reveal or transfer another principal account', async () => {
    const ownerBAccount = await createCustomerAccount(app.db, {
      currency: 'NGN',
      displayName: 'Owner B account',
      ownerSubject: 'owner-b',
      externalRef: `api-owner-b:${randomUUID()}`,
    });
    const ownerAAccount = await createCustomerAccount(app.db, {
      currency: 'NGN',
      displayName: 'Owner A account',
      ownerSubject: 'owner-a',
      externalRef: `api-owner-a:${randomUUID()}`,
    });

    const accountRead = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${ownerBAccount.id}`,
      headers: { authorization: 'Bearer owner-a' },
    });
    expect(accountRead.statusCode).toBe(404);

    const transfer = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: {
        authorization: 'Bearer owner-a',
        'idempotency-key': `cross-owner:${randomUUID()}`,
      },
      payload: {
        sourceAccountId: ownerAAccount.id,
        destinationAccountId: ownerBAccount.id,
        amountMinor: 1,
        currency: 'NGN',
      },
    });
    expect(transfer.statusCode).toBe(404);
  });

  it('requires the write scope for transfer creation', async () => {
    const readOnlyVerifier: IdentityVerifier = async () => ({
      subject: 'owner-a',
      scopes: new Set(['ledger:read']),
    });
    const readOnlyApp = await buildApp(
      loadApiEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error' }),
      { identityVerifier: readOnlyVerifier },
    );
    try {
      const response = await readOnlyApp.inject({
        method: 'POST',
        url: '/v1/transfers',
        headers: { authorization: 'Bearer read-only', 'idempotency-key': 'scope-check' },
        payload: {
          sourceAccountId: randomUUID(),
          destinationAccountId: randomUUID(),
          amountMinor: 1,
          currency: 'NGN',
        },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await readOnlyApp.close();
    }
  });
});
