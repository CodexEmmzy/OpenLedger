import { describe, expect, it } from 'vitest';
import { loadApiEnv, loadSimulatorEnv } from './env.js';

describe('env', () => {
  it('requires DATABASE_URL for the API', () => {
    expect(() => loadApiEnv({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('loads simulator env without a database', () => {
    const env = loadSimulatorEnv({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    expect(env.SIMULATOR_PORT).toBe(3001);
  });
});
