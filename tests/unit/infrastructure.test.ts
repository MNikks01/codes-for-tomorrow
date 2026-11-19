import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { buildOpenApiDocument } from '../../src/docs/openapi.js';
import {
  GrpcStatus,
  grpcCode,
  withFirestore,
} from '../../src/infrastructure/firestore/firestore-errors.js';
import { isDatabaseUnavailable } from '../../src/infrastructure/postgres/prisma-errors.js';
import { AccessTokenService } from '../../src/infrastructure/security/access-token.service.js';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../src/infrastructure/security/opaque-token.js';
import { Argon2PasswordHasher } from '../../src/infrastructure/security/password-hasher.js';
import { ReadinessService } from '../../src/modules/health/readiness.service.js';
import { comparePositions } from '../../src/modules/messages/message.types.js';
import { AppError, ExternalServiceError } from '../../src/shared/errors/app-error.js';

const tokenConfig = {
  secret: 'unit-test-secret-that-is-long-enough-0123456789',
  ttlSeconds: 900,
  issuer: 'iss',
  audience: 'aud',
};

describe('AccessTokenService', () => {
  const service = new AccessTokenService(tokenConfig);

  it('round-trips the subject', () => {
    expect(service.verify(service.sign('user-1'))).toEqual({ userId: 'user-1' });
  });

  it('flags expired tokens distinctly', () => {
    const expired = jwt.sign({}, tokenConfig.secret, {
      subject: 'u',
      issuer: 'iss',
      audience: 'aud',
      expiresIn: -10,
    });
    expect(() => service.verify(expired)).toThrow(
      expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
    );
  });

  it.each([
    [
      'wrong secret',
      jwt.sign({ sub: 'u' }, 'another-secret-another-secret-0123', {
        issuer: 'iss',
        audience: 'aud',
      }),
    ],
    [
      'wrong audience',
      jwt.sign({ sub: 'u' }, tokenConfig.secret, { issuer: 'iss', audience: 'other' }),
    ],
    [
      'wrong issuer',
      jwt.sign({ sub: 'u' }, tokenConfig.secret, { issuer: 'evil', audience: 'aud' }),
    ],
    ['missing subject', jwt.sign({}, tokenConfig.secret, { issuer: 'iss', audience: 'aud' })],
    [
      'alg none',
      `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"u","iss":"iss","aud":"aud"}').toString('base64url')}.`,
    ],
    ['garbage', 'not.a.token'],
  ])('rejects %s', (_label, token) => {
    expect(() => service.verify(token)).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
  });
});

describe('opaque tokens', () => {
  it('are high-entropy and hashed deterministically', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(token);
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
    expect(hashOpaqueToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });

  it('hashes with argon2id and verifies', async () => {
    const hash = await hasher.hash('s3cret-password');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(hasher.verify(hash, 's3cret-password')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'wrong')).resolves.toBe(false);
  });

  it('never authenticates against a malformed stored hash', async () => {
    await expect(hasher.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });
});

describe('withFirestore', () => {
  it.each([GrpcStatus.UNAVAILABLE, GrpcStatus.DEADLINE_EXCEEDED, GrpcStatus.RESOURCE_EXHAUSTED])(
    'maps transient gRPC code %i to a 503',
    async (code) => {
      await expect(
        withFirestore(() => Promise.reject(Object.assign(new Error('x'), { code }))),
      ).rejects.toBeInstanceOf(ExternalServiceError);
    },
  );

  it('passes through app errors and non-transient errors', async () => {
    const appError = new AppError(409, 'CONFLICT', 'c');
    await expect(withFirestore(() => Promise.reject(appError))).rejects.toBe(appError);
    const other = Object.assign(new Error('perm'), { code: 7 });
    await expect(withFirestore(() => Promise.reject(other))).rejects.toBe(other);
  });

  it('reads numeric codes only', () => {
    expect(grpcCode({ code: 6 })).toBe(6);
    expect(grpcCode({ code: 'P2002' })).toBeUndefined();
    expect(grpcCode(null)).toBeUndefined();
  });
});

describe('isDatabaseUnavailable', () => {
  it('detects socket errors nested in causes and aggregates', () => {
    const refused = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    expect(isDatabaseUnavailable(new Error('wrapped', { cause: refused }))).toBe(true);
    expect(isDatabaseUnavailable(new AggregateError([refused]))).toBe(true);
    expect(isDatabaseUnavailable(new Error('logic bug'))).toBe(false);
    expect(isDatabaseUnavailable('string')).toBe(false);
  });
});

describe('comparePositions', () => {
  it('orders by seconds, then nanos, then id', () => {
    const base = { seconds: 10, nanos: 5, id: 'b' };
    expect(comparePositions(base, { ...base })).toBe(0);
    expect(comparePositions(base, { ...base, seconds: 11 })).toBeLessThan(0);
    expect(comparePositions(base, { ...base, nanos: 4 })).toBeGreaterThan(0);
    expect(comparePositions(base, { ...base, id: 'c' })).toBe(-1);
    expect(comparePositions(base, { ...base, id: 'a' })).toBe(1);
  });
});

describe('ReadinessService', () => {
  const logger = { warn: vi.fn() };

  it('reports dependency status and caches results', async () => {
    let now = 0;
    const check = vi.fn().mockResolvedValue(undefined);
    const service = new ReadinessService(
      [
        { name: 'db', check },
        { name: 'broken', check: () => Promise.reject(new Error('down')) },
      ],
      { cacheTtlMs: 1000, timeoutMs: 100 },
      logger,
      () => now,
    );
    expect(await service.report()).toEqual({
      ready: false,
      shuttingDown: false,
      dependencies: { db: 'up', broken: 'down' },
    });
    await service.report();
    expect(check).toHaveBeenCalledTimes(1);
    now = 2000;
    await service.report();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('times out slow checks and reports not-ready while shutting down', async () => {
    const service = new ReadinessService(
      [{ name: 'slow', check: () => new Promise((resolve) => setTimeout(resolve, 1000)) }],
      { cacheTtlMs: 0, timeoutMs: 10 },
      logger,
    );
    expect((await service.report()).dependencies).toEqual({ slow: 'down' });
    service.markShuttingDown();
    expect(await service.report()).toEqual({ ready: false, shuttingDown: true, dependencies: {} });
  });
});

describe('loadEnv', () => {
  const valid = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    FIREBASE_PROJECT_ID: 'demo',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
  };

  it('applies defaults and parses lists and flags', () => {
    const env = loadEnv({
      ...valid,
      CORS_ORIGINS: 'https://a.io, https://b.io',
      TRUST_PROXY: 'true',
    });
    expect(env.PORT).toBe(3000);
    expect(env.CORS_ORIGINS).toEqual(['https://a.io', 'https://b.io']);
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.ENABLE_API_DOCS).toBe(false);
  });

  it('fails fast without echoing secret values', () => {
    const secret = 'too-short-secret';
    expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: secret })).toThrow(/JWT_ACCESS_SECRET/);
    try {
      loadEnv({ ...valid, JWT_ACCESS_SECRET: secret });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('OpenAPI document', () => {
  it('documents every assignment endpoint', () => {
    const document = buildOpenApiDocument('1.2.3') as {
      paths: Record<string, unknown>;
      info: { version: string };
    };
    expect(document.info.version).toBe('1.2.3');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/chat/create',
        '/chat/{chatId}/message/send',
        '/chat/{chatId}/messages',
        '/chat/{chatId}/message/{messageId}/read',
        '/chat/{chatId}/lastseen',
        '/user/{userId}/chats',
      ]),
    );
  });
});
