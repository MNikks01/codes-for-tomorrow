import { Router, type RequestHandler } from 'express';
import type { AuthController } from './auth.controller.js';

export interface AuthLimiters {
  /** Per client IP: registration and login. */
  perIp: RequestHandler;
  /** Per targeted account: login. */
  perAccount: RequestHandler;
}

export function createAuthRouter(controller: AuthController, limiters: AuthLimiters): Router {
  const router = Router();
  // Credential-accepting endpoints get much stricter limits (brute-force protection).
  router.post('/auth/register', limiters.perIp, controller.register);
  router.post('/auth/login', limiters.perIp, limiters.perAccount, controller.login);
  // Refresh tokens carry 256 bits of entropy, so only the general API limit applies.
  router.post('/auth/refresh', controller.refresh);
  router.post('/auth/logout', controller.logout);
  return router;
}
