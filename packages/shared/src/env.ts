import { z } from 'zod';

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info');

const baseSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
});

export const apiEnvSchema = baseSchema.extend({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
});

export const workerEnvSchema = baseSchema.extend({
  DATABASE_URL: z.string().min(1),
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
});

export const simulatorEnvSchema = baseSchema.extend({
  SIMULATOR_PORT: z.coerce.number().int().positive().default(3001),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type SimulatorEnv = z.infer<typeof simulatorEnvSchema>;
export type Env = ApiEnv | WorkerEnv | SimulatorEnv;

function parse<Schema extends z.ZodTypeAny>(
  schema: Schema,
  source: NodeJS.ProcessEnv,
): z.output<Schema> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return parse(apiEnvSchema, source);
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return parse(workerEnvSchema, source);
}

export function loadSimulatorEnv(source: NodeJS.ProcessEnv = process.env): SimulatorEnv {
  return parse(simulatorEnvSchema, source);
}
