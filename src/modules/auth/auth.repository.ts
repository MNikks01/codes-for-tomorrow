import type { PrismaClient } from '../../infrastructure/postgres/prisma.client.js';
import type { NewRefreshToken, RefreshTokenRecord, RefreshTokenRepository } from './auth.types.js';

export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: NewRefreshToken): Promise<void> {
    await this.prisma.refreshToken.create({ data });
  }

  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, familyId: true, expiresAt: true, revokedAt: true },
    });
  }

  rotate(oldTokenId: string, at: Date, next: NewRefreshToken): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Conditional update = compare-and-swap: only one concurrent caller can win.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: oldTokenId, revokedAt: null },
        data: { revokedAt: at },
      });
      if (count !== 1) return false;
      // Same transaction: the old token is never burned without its successor existing.
      await tx.refreshToken.create({ data: next });
      return true;
    });
  }

  async deleteExpired(userId: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { userId, expiresAt: { lt: now } } });
  }

  async revokeFamily(familyId: string, at: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: at },
    });
  }
}
