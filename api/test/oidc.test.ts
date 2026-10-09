import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiEnv } from '@openledger/shared';
import { createOidcVerifier } from '../src/auth/oidc.js';

describe('OIDC bearer verification', () => {
  const issuer = 'http://localhost:48123/openledger-issuer';
  const audience = 'openledger-api';
  const keyId = 'integration-key-1';
  let server: Server;
  let port: number;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let verify: NonNullable<ReturnType<typeof createOidcVerifier>>;

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = keyId;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    server = createServer((request, response) => {
      if (request.url !== '/jwks.json') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OIDC test JWKS server did not bind a TCP port');
    }
    port = address.port;

    const env = loadApiEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unused:unused@localhost/unused',
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: audience,
      OIDC_JWKS_URL: `http://localhost:${port}/jwks.json`,
    });
    verify = createOidcVerifier(env)!;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('accepts an issuer/audience-valid signature and returns subject and scopes', async () => {
    const token = await new SignJWT({ scope: 'ledger:read ledger:write' })
      .setProtectedHeader({ alg: 'RS256', kid: keyId })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('customer-42')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verify(`Bearer ${token}`)).resolves.toEqual({
      subject: 'customer-42',
      scopes: new Set(['ledger:read', 'ledger:write']),
    });
  });

  it('rejects an incorrectly issued token and malformed authorization header', async () => {
    const token = await new SignJWT({ scope: 'ledger:write' })
      .setProtectedHeader({ alg: 'RS256', kid: keyId })
      .setIssuer('https://wrong-issuer.example')
      .setAudience(audience)
      .setSubject('customer-42')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verify(`Bearer ${token}`)).rejects.toThrow(/invalid bearer token/);
    await expect(verify(`Basic ${token}`)).rejects.toThrow(/bearer token required/);
  });
});
