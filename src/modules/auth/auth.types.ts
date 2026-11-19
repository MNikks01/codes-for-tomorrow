import type { PublicUser } from '../users/user.types.js';

export interface NewRefreshToken {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface RefreshTokenRepository {
  create(data: NewRefreshToken): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /**
   * Atomically marks the old token used and stores its successor.
   * Returns false (and stores nothing) if the old token was already used or revoked.
   */
  rotate(oldTokenId: string, at: Date, next: NewRefreshToken): Promise<boolean>;
  /** Removes a user's expired tokens; revoked-but-unexpired ones stay for reuse detection. */
  deleteExpired(userId: string, now: Date): Promise<void>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface AuthResult {
  user: PublicUser;
  tokens: AuthTokens;
}
