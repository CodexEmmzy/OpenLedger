import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import swagger from '@fastify/swagger';
import ajvFormats from 'ajv-formats';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { type ApiEnv, createLogger } from '@openledger/shared';
import postgresPlugin from './plugins/postgres.js';
import { loadOpenApiSpec, specPath } from './openapi/load-spec.js';
import { healthRoutes } from './routes/health.js';
import { v1Routes } from './routes/v1.js';

export async function buildApp(env: ApiEnv): Promise<FastifyInstance> {
  const logger = createLogger(env);
  const spec = loadOpenApiSpec();

  const app = Fastify<HttpServer, IncomingMessage, ServerResponse>({
    loggerInstance: logger,
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0) {
        return header;
      }
      return randomUUID();
    },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    disableRequestLogging: false,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        allErrors: true,
      },
      plugins: [(ajv) => ajvFormats.default(ajv)],
    },
  });

  await app.register(postgresPlugin, { databaseUrl: env.DATABASE_URL });
  await app.register(swagger, {
    mode: 'static',
    specification: {
      path: specPath(),
      baseDir: process.cwd(),
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    const validation = err.validation;
    if (validation) {
      return reply.code(400).send({
        error: 'validation_error',
        message: err.message,
        requestId: request.id,
      });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: 'internal_error',
      message: 'internal error',
      requestId: request.id,
    });
  });

  await healthRoutes(app);
  await v1Routes(app, spec);
  return app;
}
