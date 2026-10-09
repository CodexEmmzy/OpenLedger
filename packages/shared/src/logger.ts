import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Env } from './env.js';

export function createLogger(env: Pick<Env, 'LOG_LEVEL'>): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    redact: {
      paths: ['req.headers.authorization', 'password', 'DATABASE_URL'],
      remove: true,
    },
  };

  return pino(options);
}
