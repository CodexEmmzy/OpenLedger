import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { componentSchema, type OpenApiSpec } from '../openapi/load-spec.js';

function notImplemented(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(501).send({
    error: 'not_implemented',
    message: 'Phase 0 stub; ledger writes land in a later phase',
    requestId: request.id,
  });
}

const uuidParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export async function v1Routes(app: FastifyInstance, spec: OpenApiSpec): Promise<void> {
  app.post(
    '/v1/accounts',
    { schema: { body: componentSchema(spec, 'CreateAccountRequest') } },
    notImplemented,
  );

  app.get('/v1/accounts/:id', { schema: { params: uuidParams } }, notImplemented);

  app.get('/v1/accounts/:id/balance', { schema: { params: uuidParams } }, notImplemented);

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
    },
    notImplemented,
  );

  app.get('/v1/transfers/:id', { schema: { params: uuidParams } }, notImplemented);
}
