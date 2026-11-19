import type { Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError } from '../shared/errors/app-error.js';

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
}

/**
 * In-memory store: limits are per instance. Behind several replicas, switch to a
 * shared store (e.g. Redis) so limits apply cluster-wide.
 */
export function createRateLimiter(
  options: RateLimitOptions,
  keyGenerator?: (req: Request) => string,
): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    ...(keyGenerator ? { keyGenerator } : {}),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests, please try again later'));
    },
  });
}

/**
 * Keys login attempts by the targeted account, so rotating source IPs does not
 * bypass brute-force protection for a single user.
 */
export function loginAccountKey(req: Request): string {
  const body: unknown = req.body;
  const email =
    typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : '';
  return `login:${email}`;
}
