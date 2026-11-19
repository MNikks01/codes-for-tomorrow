import type { PrismaClient } from '../../infrastructure/postgres/prisma.client.js';
import { isUniqueViolation } from '../../infrastructure/postgres/prisma-errors.js';
import { ConflictError } from '../../shared/errors/app-error.js';
import type { NewUser, UserRecord, UserRepository } from './user.types.js';

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: NewUser): Promise<UserRecord> {
    try {
      return await this.prisma.user.create({ data });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('An account with this email already exists');
      }
      throw error;
    }
  }

  findById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  countExisting(ids: readonly string[]): Promise<number> {
    return this.prisma.user.count({ where: { id: { in: [...new Set(ids)] } } });
  }
}
