import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiEnv } from '@openledger/shared';
import { createLogger, loadWorkerEnv } from '@openledger/shared';
import type { IdentityVerifier } from '../src/auth/oidc.js';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { processOutboxBatch } from '../../worker/src/jobs/outbox.js';

const webhookSecret = 'test-paystack-webhook-secret-not-for-production';

describe('Paystack payment intent and webhook boundary', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = loadApiEnv({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      PAYSTACK_SECRET_KEY: webhookSecret,
    });
    const identityVerifier: IdentityVerifier = async (authorization) => {
      if (authorization !== 'Bearer paystack-test-owner') {
        throw new Error('invalid token');
      }
      return { subject: 'paystack-test-owner', scopes: new Set(['ledger:read', 'ledger:write']) };
    };
    app = await buildApp(env, { identityVerifier });
  });

  afterAll(async () => {
    await app.close();
  });

  it('persists a signed-webhook-ready payment intent and deduplicates webhook retries', async () => {
    const account = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer paystack-test-owner' },
      payload: { currency: 'NGN', displayName: 'Paystack test wallet' },
    });
    expect(account.statusCode).toBe(201);

    const depositRequest = {
      method: 'POST',
      url: '/v1/deposits',
      headers: {
        authorization: 'Bearer paystack-test-owner',
        'idempotency-key': `deposit:${randomUUID()}`,
      },
      payload: {
        accountId: account.json().id,
        amountMinor: 12345,
        currency: 'NGN',
        email: 'customer@example.test',
      },
    } as const;
    const intent = await app.inject(depositRequest);
    expect(intent.statusCode).toBe(202);
    expect(intent.json().status).toBe('pending');
    const intentRetry = await app.inject(depositRequest);
    expect(intentRetry.statusCode).toBe(200);
    expect(intentRetry.json().reference).toBe(intent.json().reference);
    const changedRetry = await app.inject({
      ...depositRequest,
      payload: { ...depositRequest.payload, amountMinor: 54321 },
    });
    expect(changedRetry.statusCode).toBe(409);

    const persisted = await app.db.query<{ status: string }>(
      'SELECT status FROM provider_payments WHERE reference = $1',
      [intent.json().reference],
    );
    expect(persisted.rows[0]?.status).toBe('pending');

    const eventBody = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: intent.json().reference,
        amount: 12345,
        currency: 'NGN',
        status: 'success',
      },
    });
    const signature = createHmac('sha512', webhookSecret).update(eventBody).digest('hex');
    const webhook = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
      payload: eventBody,
    });
    expect(webhook.statusCode).toBe(202);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
      payload: eventBody,
    });
    expect(duplicate.statusCode).toBe(200);

    const workerEnv = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: process.env.DATABASE_URL,
    });
    await processOutboxBatch(
      app.db,
      workerEnv,
      createLogger(workerEnv),
      `paystack-test-worker-${randomUUID()}`,
      10,
      async (_config, reference) => ({
        reference,
        status: 'success',
        amountMinor: 12345n,
        currency: 'NGN',
      }),
    );

    const storedEvents = await app.db.query(
      `SELECT 1 FROM provider_events
       WHERE provider = 'paystack' AND reference = $1`,
      [intent.json().reference],
    );
    const webhookJobs = await app.db.query(
      `SELECT 1 FROM outbox_events
       WHERE event_type = 'provider.paystack.event'
         AND payload->>'eventId' = (SELECT id::text FROM provider_events WHERE reference = $1)`,
      [intent.json().reference],
    );
    expect(storedEvents.rowCount).toBe(1);
    expect(webhookJobs.rowCount).toBe(1);
    const payment = await app.db.query<{ status: string }>(
      'SELECT status FROM provider_payments WHERE reference = $1',
      [intent.json().reference],
    );
    expect(payment.rows[0]?.status).toBe('succeeded');
    const accountBalance = await app.db.query<{ balance_minor: string }>(
      `SELECT balance_minor::text FROM account_balances WHERE account_id = $1`,
      [account.json().id],
    );
    expect(accountBalance.rows[0]?.balance_minor).toBe('12345');
  });

  it('rejects a changed body signed with a prior webhook signature', async () => {
    const firstBody = JSON.stringify({
      event: 'charge.success',
      data: { reference: randomUUID() },
    });
    const signature = createHmac('sha512', webhookSecret).update(firstBody).digest('hex');
    const tamperedBody = JSON.stringify({
      event: 'charge.success',
      data: { reference: randomUUID() },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
      payload: tamperedBody,
    });
    expect(response.statusCode).toBe(401);
  });
});
