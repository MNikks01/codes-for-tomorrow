import type { Request, RequestHandler } from 'express';
import type {
  AccessTokenClaims,
  AccessTokenVerifier,
} from '../infrastructure/security/access-token.service.js';
import { AuthenticationError } from '../shared/errors/app-error.js';

// Keyed by request object: typed, no global augmentation, garbage-collected with the request.
const authContexts = new WeakMap<Request, AccessTokenClaims>();

const BEARER = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i;

/** Identity is derived only from a verified JWT, never from body or URL parameters. */
export function createAuthenticate(verifier: AccessTokenVerifier): RequestHandler {
  return (req, _res, next) => {
    const token = BEARER.exec(req.get('authorization') ?? '')?.[1];
    if (!token) {
      next(new AuthenticationError());
      return;
    }
    authContexts.set(req, verifier.verify(token));
    next();
  };
}

export function requireAuth(req: Request): AccessTokenClaims {
  const claims = authContexts.get(req);
  if (!claims) throw new AuthenticationError();
  return claims;
}
