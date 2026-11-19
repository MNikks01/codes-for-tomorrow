import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

export type { PrismaClient };

export function createPrismaClient(databaseUrl: string, poolMax: number): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    max: poolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter });
}
