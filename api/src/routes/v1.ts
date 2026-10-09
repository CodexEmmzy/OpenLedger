import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityVerifier } from '../auth/oidc.js';
import {
  createCustomerAccount,
  createPaystackPaymentIntent,
  getAccountBalance,
  getCustomerAccountForOwner,
  getProviderPaymentForOwner,
  getTransferForOwner,
  IdempotencyConflictError,
  postLedgerTransaction,
  recordPaystackEvent,
} from '../modules/ledger/ledger-repository.js';
import { componentSchema, type OpenApiSpec } from '../openapi/load-spec.js';
import { verifyPaystackSignature } from '@openledger/shared';

const uuidParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

interface CreateAccountBody {
  currency: 'NGN' | 'USD';
  displayName?: string;
}

interface CreateTransferBody {
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: number;
  currency: 'NGN' | 'USD';
}

interface IdParams {
  id: string;
}

interface ReferenceParams {
  reference: string;
}

interface CreateDepositBody {
  accountId: string;
  amountMinor: number;
  currency: 'NGN' | 'USD';
  email: string;
}

interface PaystackWebhookBody {
  event?: unknown;
  data?: {
    reference?: unknown;
    amount?: unknown;
    currency?: unknown;
    status?: unknown;
  };
}

export async function v1Routes(
  app: FastifyInstance,
  spec: OpenApiSpec,
  identityVerifier: IdentityVerifier | undefined,
  providerConfig: { paystackSecretKey: string | undefined; paystackBaseUrl: string },
): Promise<void> {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!identityVerifier) {
      return reply.code(503).send({
        error: 'identity_not_configured',
        message: 'identity verification is not configured',
        requestId: request.id,
      });
    }
    try {
      request.principal = await identityVerifier(request.headers.authorization);
    } catch {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'valid bearer token required',
        requestId: request.id,
      });
    }
  };

  const requireScope = (scope: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.principal) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'valid bearer token required',
        requestId: request.id,
      });
    }
    if (!request.principal.scopes.has(scope)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'required scope is missing',
        requestId: request.id,
      });
    }
  };

  const errorResponse = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    if (error instanceof IdempotencyConflictError) {
      return reply.code(409).send({
        error: 'idempotency_conflict',
        message: 'idempotency key was already used for a different request',
        requestId: request.id,
      });
    }
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === '23514') {
      return reply.code(409).send({
        error: 'ledger_conflict',
        message: 'the requested ledger operation conflicts with account state',
        requestId: request.id,
      });
    }
    request.log.error({ err: error }, 'ledger route failed');
    return reply.code(500).send({
      error: 'internal_error',
      message: 'internal error',
      requestId: request.id,
    });
  };

  app.post(
    '/v1/accounts',
    {
      schema: { body: componentSchema(spec, 'CreateAccountRequest') },
      preHandler: [authenticate, requireScope('ledger:write')],
    },
    async (request, reply) => {
      const body = request.body as CreateAccountBody;
      try {
        const account = await createCustomerAccount(app.db, {
          currency: body.currency,
          displayName: body.displayName ?? 'Customer wallet',
          ownerSubject: request.principal!.subject,
        });
        return reply.code(201).send({
          id: account.id,
          currency: account.currency,
          displayName: account.displayName,
          status: account.status,
          createdAt: account.createdAt.toISOString(),
        });
      } catch (error) {
        return errorResponse(request, reply, error);
      }
    },
  );

  app.get(
    '/v1/accounts/:id',
    {
      schema: { params: uuidParams },
      preHandler: [authenticate, requireScope('ledger:read')],
    },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const account = await getCustomerAccountForOwner(app.db, id, request.principal!.subject);
      if (!account) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'account not found',
          requestId: request.id,
        });
      }
      return {
        id: account.id,
        currency: account.currency,
        displayName: account.displayName,
        status: account.status,
        createdAt: account.createdAt.toISOString(),
      };
    },
  );

  app.get(
    '/v1/accounts/:id/balance',
    {
      schema: { params: uuidParams },
      preHandler: [authenticate, requireScope('ledger:read')],
    },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const account = await getCustomerAccountForOwner(app.db, id, request.principal!.subject);
      if (!account) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'account not found',
          requestId: request.id,
        });
      }
      const balance = await getAccountBalance(app.db, id);
      return {
        accountId: balance.accountId,
        amountMinor: serializeMinorUnits(balance.balanceMinor),
        currency: balance.currency,
      };
    },
  );

  app.post(
    '/v1/transfers',
    {
      schema: {
        body: componentSchema(spec, 'CreateTransferRequest'),
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
      preHandler: [authenticate, requireScope('ledger:write')],
    },
    async (request, reply) => {
      const body = request.body as CreateTransferBody;
      if (!Number.isSafeInteger(body.amountMinor) || body.amountMinor <= 0) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'amountMinor must be a positive safe integer',
          requestId: request.id,
        });
      }
      if (body.sourceAccountId === body.destinationAccountId) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'source and destination accounts must differ',
          requestId: request.id,
        });
      }
      const ownerSubject = request.principal!.subject;
      const [source, destination] = await Promise.all([
        getCustomerAccountForOwner(app.db, body.sourceAccountId, ownerSubject),
        getCustomerAccountForOwner(app.db, body.destinationAccountId, ownerSubject),
      ]);
      if (!source || !destination) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'account not found',
          requestId: request.id,
        });
      }
      if (source.currency !== body.currency || destination.currency !== body.currency) {
        return reply.code(409).send({
          error: 'currency_mismatch',
          message: 'both accounts must match the transfer currency',
          requestId: request.id,
        });
      }
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'exactly one Idempotency-Key header is required',
          requestId: request.id,
        });
      }
      try {
        const result = await postLedgerTransaction(app.db, {
          idempotencyKey,
          type: 'transfer',
          currency: body.currency,
          entries: [
            {
              accountId: source.id,
              direction: 'debit',
              amountMinor: BigInt(body.amountMinor),
            },
            {
              accountId: destination.id,
              direction: 'credit',
              amountMinor: BigInt(body.amountMinor),
            },
          ],
        });
        const transfer = await getTransferForOwner(app.db, result.id, ownerSubject);
        if (!transfer) {
          throw new Error('committed transfer is not visible to its owner');
        }
        const response = {
          id: transfer.id,
          sourceAccountId: transfer.sourceAccountId,
          destinationAccountId: transfer.destinationAccountId,
          amountMinor: serializeMinorUnits(transfer.amountMinor),
          currency: transfer.currency,
          createdAt: transfer.createdAt.toISOString(),
        };
        return reply.code(result.duplicate ? 200 : 201).send(response);
      } catch (error) {
        return errorResponse(request, reply, error);
      }
    },
  );

  app.get(
    '/v1/transfers/:id',
    {
      schema: { params: uuidParams },
      preHandler: [authenticate, requireScope('ledger:read')],
    },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const transfer = await getTransferForOwner(app.db, id, request.principal!.subject);
      if (!transfer) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'transfer not found',
          requestId: request.id,
        });
      }
      return {
        id: transfer.id,
        sourceAccountId: transfer.sourceAccountId,
        destinationAccountId: transfer.destinationAccountId,
        amountMinor: serializeMinorUnits(transfer.amountMinor),
        currency: transfer.currency,
        createdAt: transfer.createdAt.toISOString(),
      };
    },
  );

  app.post(
    '/v1/deposits',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['accountId', 'amountMinor', 'currency', 'email'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
            amountMinor: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            currency: { type: 'string', enum: ['NGN', 'USD'] },
            email: { type: 'string', format: 'email', maxLength: 254 },
          },
        },
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
      preHandler: [authenticate, requireScope('ledger:write')],
    },
    async (request, reply) => {
      if (!providerConfig.paystackSecretKey) {
        return reply.code(503).send({
          error: 'provider_not_configured',
          message: 'deposit provider is not configured',
          requestId: request.id,
        });
      }
      const body = request.body as CreateDepositBody;
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'exactly one Idempotency-Key header is required',
          requestId: request.id,
        });
      }
      if (!Number.isSafeInteger(body.amountMinor) || body.amountMinor <= 0) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'amountMinor must be a positive safe integer',
          requestId: request.id,
        });
      }
      const account = await getCustomerAccountForOwner(
        app.db,
        body.accountId,
        request.principal!.subject,
      );
      if (!account) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'account not found',
          requestId: request.id,
        });
      }
      if (account.currency !== body.currency || account.status !== 'active') {
        return reply.code(409).send({
          error: 'account_conflict',
          message: 'account status or currency does not permit this deposit',
          requestId: request.id,
        });
      }
      try {
        const payment = await createPaystackPaymentIntent(app.db, {
          reference: randomUUID(),
          idempotencyKey,
          accountId: account.id,
          ownerSubject: request.principal!.subject,
          amountMinor: BigInt(body.amountMinor),
          currency: body.currency,
          customerEmail: body.email,
        });
        return reply.code(payment.status === 'pending' ? 202 : 200).send({
          reference: payment.reference,
          status: payment.status,
        });
      } catch (error) {
        return errorResponse(request, reply, error);
      }
    },
  );

  app.get(
    '/v1/deposits/:reference',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['reference'],
          properties: { reference: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
      preHandler: [authenticate, requireScope('ledger:read')],
    },
    async (request, reply) => {
      const { reference } = request.params as ReferenceParams;
      const payment = await getProviderPaymentForOwner(
        app.db,
        reference,
        request.principal!.subject,
      );
      if (!payment) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'payment not found',
          requestId: request.id,
        });
      }
      return {
        reference: payment.reference,
        amountMinor: serializeMinorUnits(payment.amountMinor),
        currency: payment.currency,
        status: payment.status,
        authorizationUrl: payment.authorizationUrl,
        createdAt: payment.createdAt.toISOString(),
      };
    },
  );

  app.post('/webhooks/paystack', { config: { rawBody: true } }, async (request, reply) => {
    if (!providerConfig.paystackSecretKey) {
      return reply.code(503).send({ error: 'provider_not_configured' });
    }
    if (!Buffer.isBuffer(request.rawBody)) {
      return reply.code(400).send({ error: 'raw_body_required' });
    }
    const signature = request.headers['x-paystack-signature'];
    if (
      typeof signature !== 'string' ||
      !verifyPaystackSignature(providerConfig.paystackSecretKey, request.rawBody, signature)
    ) {
      return reply.code(401).send({ error: 'invalid_webhook_signature' });
    }

    const body = request.body as PaystackWebhookBody;
    if (body.event !== 'charge.success') {
      return reply.code(200).send({ received: true, ignored: true });
    }
    const data = body.data;
    if (
      !data ||
      typeof data.reference !== 'string' ||
      !Number.isSafeInteger(data.amount) ||
      Number(data.amount) <= 0 ||
      typeof data.currency !== 'string' ||
      data.status !== 'success'
    ) {
      return reply.code(400).send({ error: 'invalid_webhook_payload' });
    }

    const result = await recordPaystackEvent(app.db, {
      eventKey: `charge.success:${data.reference}`,
      eventType: 'charge.success',
      reference: data.reference,
      amountMinor: BigInt(Number(data.amount)),
      currency: data.currency,
      payloadHash: createHash('sha256').update(request.rawBody).digest('hex'),
    });
    if (result === 'conflict') {
      request.log.error(
        { reference: data.reference },
        'Paystack webhook event key payload conflict',
      );
      return reply.code(409).send({ error: 'webhook_event_conflict' });
    }
    return reply.code(result === 'duplicate' ? 200 : 202).send({ received: true });
  });
}

function serializeMinorUnits(amount: bigint): number | string {
  if (amount <= BigInt(Number.MAX_SAFE_INTEGER) && amount >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(amount);
  }
  return amount.toString();
}
