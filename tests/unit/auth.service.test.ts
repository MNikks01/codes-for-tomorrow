import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { AuthenticationError, ConflictError } from '../../src/shared/errors/app-error.js';
import {
  FakePasswordHasher,
  FakeTokenIssuer,
  InMemoryRefreshTokenRepository,
  InMemoryUserRepository,
} from '../fixtures/fakes.js';

describe('AuthService', () => {
  let users: InMemoryUserRepository;
  let tokens: InMemoryRefreshTokenRepository;
  let hasher: FakePasswordHasher;
  let now: Date;
  let service: AuthService;

  beforeEach(() => {
    users = new InMemoryUserRepository();
    tokens = new InMemoryRefreshTokenRepository();
    hasher = new FakePasswordHasher();
    now = new Date('2026-06-01T00:00:00.000Z');
    service = new AuthService(users, tokens, hasher, new FakeTokenIssuer(), {
      refreshTokenTtlDays: 30,
      now: () => now,
    });
  });

  const register = () =>
    service.register({ name: 'Ada', email: 'ada@example.com', password: 'long-password-123' });

  describe('register', () => {
    it('stores only a hash and returns a public user with tokens', async () => {
      const result = await register();
      const stored = [...users.users.values()][0];
      expect(stored?.passwordHash).toBe('hashed:long-password-123');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(result.tokens.accessToken).toBe(`access-token-for:${result.user.id}`);
    });

    it('persists only the hash of the refresh token, with the configured expiry', async () => {
      const result = await register();
      const record = [...tokens.tokens.values()][0];
      expect(record?.tokenHash).not.toContain(result.tokens.refreshToken);
      expect(record?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record?.expiresAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });

    it('propagates duplicate-email conflicts', async () => {
      await register();
      await expect(register()).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('login', () => {
    it('returns tokens for valid credentials', async () => {
      await register();
      const result = await service.login({
        email: 'ada@example.com',
        password: 'long-password-123',
      });
      expect(result.user.email).toBe('ada@example.com');
    });

    it('rejects a wrong password with a generic error', async () => {
      await register();
      await expect(
        service.login({ email: 'ada@example.com', password: 'wrong-password' }),
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    });

    it('rejects an unknown email with the same error and still runs a hash verification', async () => {
      await expect(
        service.login({ email: 'nobody@example.com', password: 'whatever-password' }),
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
      expect(hasher.verifyCalls).toBe(1);
    });
  });

  describe('refresh', () => {
    it('rotates: returns a new pair and invalidates the old refresh token', async () => {
      const { tokens: first } = await register();
      const second = await service.refresh(first.refreshToken);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      await expect(service.refresh(second.refreshToken)).resolves.toBeDefined();
    });

    it('treats reuse of a consumed token as theft and revokes the whole family', async () => {
      const { tokens: first } = await register();
      const second = await service.refresh(first.refreshToken);

      await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(AuthenticationError);
      // The legitimately rotated token is now revoked too.
      await expect(service.refresh(second.refreshToken)).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    });

    it('rejects unknown tokens', async () => {
      await expect(service.refresh('x'.repeat(43))).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('rejects expired tokens', async () => {
      const { tokens: first } = await register();
      now = new Date('2026-07-02T00:00:00.000Z');
      await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('revokes the family when it loses a concurrent consume race', async () => {
      const { tokens: first } = await register();
      tokens.failNextConsume = true;
      await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(AuthenticationError);
      expect([...tokens.tokens.values()].every((token) => token.revokedAt !== null)).toBe(true);
    });
  });

  describe('logout', () => {
    it('revokes the refresh token family', async () => {
      const { tokens: first } = await register();
      await service.logout(first.refreshToken);
      await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('is a no-op for unknown tokens', async () => {
      await expect(service.logout('y'.repeat(43))).resolves.toBeUndefined();
    });
  });
});
