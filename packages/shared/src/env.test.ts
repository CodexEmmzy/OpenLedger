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

  it('requires complete OIDC configuration when any OIDC setting is supplied', () => {
    expect(() =>
      loadApiEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://local',
        OIDC_ISSUER: 'https://identity.example.test',
      }),
    ).toThrow(/configured together/);
  });

  it('requires OIDC verification settings in production', () => {
    expect(() => loadApiEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://local' })).toThrow(
      /required in production/,
    );
  });
});
