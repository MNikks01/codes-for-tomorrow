import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AuthenticationError } from '../../shared/errors/app-error.js';

export interface AccessTokenConfig {
  secret: string;
  ttlSeconds: number;
  issuer: string;
  audience: string;
}

export interface AccessTokenClaims {
  userId: string;
}

export interface AccessTokenVerifier {
  verify(token: string): AccessTokenClaims;
}

export interface AccessTokenIssuer {
  readonly ttlSeconds: number;
  sign(userId: string): string;
}

const ALGORITHM = 'HS256';

export class AccessTokenService implements AccessTokenVerifier, AccessTokenIssuer {
  constructor(private readonly config: AccessTokenConfig) {}

  get ttlSeconds(): number {
    return this.config.ttlSeconds;
  }

  sign(userId: string): string {
    return jwt.sign({}, this.config.secret, {
      algorithm: ALGORITHM,
      subject: userId,
      issuer: this.config.issuer,
      audience: this.config.audience,
      expiresIn: this.config.ttlSeconds,
      jwtid: randomUUID(),
    });
  }

  verify(token: string): AccessTokenClaims {
    let payload: string | jwt.JwtPayload;
    try {
      // Pinning the algorithm blocks "alg: none" and algorithm-confusion attacks.
      payload = jwt.verify(token, this.config.secret, {
        algorithms: [ALGORITHM],
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthenticationError('Access token has expired', 'TOKEN_EXPIRED');
      }
      throw new AuthenticationError('Invalid access token');
    }
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.sub === '') {
      throw new AuthenticationError('Invalid access token');
    }
    return { userId: payload.sub };
  }
}
