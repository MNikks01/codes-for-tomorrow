import { randomUUID } from 'node:crypto';
import type { AccessTokenIssuer } from '../../infrastructure/security/access-token.service.js';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../infrastructure/security/opaque-token.js';
import type { PasswordHasher } from '../../infrastructure/security/password-hasher.js';
import { AuthenticationError } from '../../shared/errors/app-error.js';
import { toPublicUser, type UserRepository } from '../users/user.types.js';
import type {
  AuthResult,
  AuthTokens,
  NewRefreshToken,
  RefreshTokenRepository,
} from './auth.types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthServiceConfig {
  refreshTokenTtlDays: number;
  now?: () => Date;
}

export class AuthService {
  private dummyHash: Promise<string> | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly users: UserRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly hasher: PasswordHasher,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly config: AuthServiceConfig,
  ) {
    this.now = config.now ?? (() => new Date());
  }

  async register(input: { name: string; email: string; password: string }): Promise<AuthResult> {
    const passwordHash = await this.hasher.hash(input.password);
    const user = await this.users.create({ name: input.name, email: input.email, passwordHash });
    return { user: toPublicUser(user), tokens: await this.issueTokens(user.id, randomUUID()) };
  }

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const user = await this.users.findByEmail(input.email);
    if (!user) {
      // Spend the same hashing time as a real check so response timing does not reveal accounts.
      await this.hasher.verify(await this.getDummyHash(), input.password);
      throw invalidCredentials();
    }
    if (!(await this.hasher.verify(user.passwordHash, input.password))) {
      throw invalidCredentials();
    }
    // Housekeeping keeps refresh_tokens bounded per user without a separate cron job.
    await this.refreshTokens.deleteExpired(user.id, this.now());
    return { user: toPublicUser(user), tokens: await this.issueTokens(user.id, randomUUID()) };
  }

  /** Rotates a refresh token. Replaying an already-used token revokes the whole family. */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const now = this.now();
    const record = await this.refreshTokens.findByHash(hashOpaqueToken(refreshToken));
    if (!record) throw invalidRefreshToken();

    if (record.revokedAt !== null) {
      await this.refreshTokens.revokeFamily(record.familyId, now);
      throw invalidRefreshToken();
    }
    if (record.expiresAt <= now) throw invalidRefreshToken();

    const next = this.newRefreshToken(record.userId, record.familyId);
    if (!(await this.refreshTokens.rotate(record.id, now, next.record))) {
      // Lost a race with another use of the same token: treat it as a replay.
      await this.refreshTokens.revokeFamily(record.familyId, now);
      throw invalidRefreshToken();
    }
    return this.toTokens(record.userId, next.token);
  }

  async logout(refreshToken: string): Promise<void> {
    const record = await this.refreshTokens.findByHash(hashOpaqueToken(refreshToken));
    if (record) await this.refreshTokens.revokeFamily(record.familyId, this.now());
  }

  private async issueTokens(userId: string, familyId: string): Promise<AuthTokens> {
    const next = this.newRefreshToken(userId, familyId);
    await this.refreshTokens.create(next.record);
    return this.toTokens(userId, next.token);
  }

  private newRefreshToken(
    userId: string,
    familyId: string,
  ): { token: string; record: NewRefreshToken } {
    const token = generateOpaqueToken();
    return {
      token,
      record: {
        userId,
        familyId,
        tokenHash: hashOpaqueToken(token),
        expiresAt: new Date(this.now().getTime() + this.config.refreshTokenTtlDays * DAY_MS),
      },
    };
  }

  private toTokens(userId: string, refreshToken: string): AuthTokens {
    return {
      accessToken: this.accessTokens.sign(userId),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTokens.ttlSeconds,
    };
  }

  private getDummyHash(): Promise<string> {
    // A failed hash must not be cached, or every unknown-email login would fail forever.
    this.dummyHash ??= this.hasher.hash(generateOpaqueToken()).catch((error: unknown) => {
      this.dummyHash = undefined;
      throw error;
    });
    return this.dummyHash;
  }
}

function invalidCredentials(): AuthenticationError {
  return new AuthenticationError('Invalid email or password', 'INVALID_CREDENTIALS');
}

function invalidRefreshToken(): AuthenticationError {
  return new AuthenticationError('Invalid or expired refresh token');
}
