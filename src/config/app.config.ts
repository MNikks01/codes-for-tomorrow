import type { RateLimitOptions } from '../middleware/rate-limit.js';
import type { Env } from './env.js';

export interface AppOptions {
  version: string;
  corsOrigins: string[];
  trustProxy: boolean;
  enableApiDocs: boolean;
  bodyLimit: string;
  apiRateLimit: RateLimitOptions;
  authRateLimit: RateLimitOptions;
}

export function toAppOptions(env: Env, version: string): AppOptions {
  return {
    version,
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
    enableApiDocs: env.ENABLE_API_DOCS,
    // Largest legitimate body is a 4,000-character message (<= 16 KB in UTF-8).
    bodyLimit: '32kb',
    apiRateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_MAX },
    authRateLimit: { windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS, limit: env.AUTH_RATE_LIMIT_MAX },
  };
}
