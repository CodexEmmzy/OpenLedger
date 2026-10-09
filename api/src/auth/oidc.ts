import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { ApiEnv } from '@openledger/shared';

export interface AuthenticatedPrincipal {
  subject: string;
  scopes: ReadonlySet<string>;
}

export type IdentityVerifier = (
  authorization: string | undefined,
) => Promise<AuthenticatedPrincipal>;

export class AuthenticationError extends Error {
  constructor(message = 'invalid bearer token') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export function createOidcVerifier(env: ApiEnv): IdentityVerifier | undefined {
  if (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE || !env.OIDC_JWKS_URL) {
    return undefined;
  }

  const issuer = env.OIDC_ISSUER;
  const audience = env.OIDC_AUDIENCE;
  const jwks = createRemoteJWKSet(new URL(env.OIDC_JWKS_URL));

  return async (authorization) => {
    if (!authorization?.startsWith('Bearer ')) {
      throw new AuthenticationError('bearer token required');
    }
    const token = authorization.slice('Bearer '.length).trim();
    if (!token || token.length > 16_384) {
      throw new AuthenticationError();
    }

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience,
        algorithms: ['RS256', 'ES256'],
        clockTolerance: 5,
        maxTokenAge: '15m',
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) {
        throw new AuthenticationError();
      }
      const scope = typeof payload.scope === 'string' ? payload.scope : '';
      return { subject: payload.sub, scopes: new Set(scope.split(/\s+/).filter(Boolean)) };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError();
    }
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal | null;
  }
}
