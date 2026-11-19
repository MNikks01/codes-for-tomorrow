/**
 * Idempotent development seed: re-running it never duplicates users, chats or messages.
 * Usage: pnpm db:seed   (requires PostgreSQL + Firestore/emulator from .env)
 */
import { pino } from 'pino';
import { loadEnv } from '../src/config/env.js';
import { buildContainer } from '../src/container.js';
import { createPrismaClient } from '../src/infrastructure/postgres/prisma.client.js';

const SEED_PASSWORD = process.env['SEED_USER_PASSWORD'] ?? 'local-dev-password-123';
const SEED_USERS = [
  { name: 'Alice Example', email: 'alice@example.com' },
  { name: 'Bob Example', email: 'bob@example.com' },
  { name: 'Carol Example', email: 'carol@example.com' },
] as const;

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed a production environment');

  const logger = pino({ level: 'info' });
  const container = buildContainer(env, logger);
  const prisma = createPrismaClient(env.DATABASE_URL, 2);
  const { authService, chatService, messageService } = container.services;

  try {
    const ids: string[] = [];
    for (const user of SEED_USERS) {
      const existing = await prisma.user.findUnique({ where: { email: user.email } });
      ids.push(
        existing?.id ?? (await authService.register({ ...user, password: SEED_PASSWORD })).user.id,
      );
    }
    const [alice, bob] = ids;
    if (!alice || !bob) throw new Error('Seed users missing');

    const { chat } = await chatService.createOrGetDirect(alice, { userAId: alice, userBId: bob });
    await messageService.send(alice, chat.id, { text: 'Hi Bob!', idempotencyKey: 'seed-msg-001' });
    await messageService.send(bob, chat.id, { text: 'Hey Alice!', idempotencyKey: 'seed-msg-002' });

    logger.info(
      { users: SEED_USERS.map((user) => user.email), chatId: chat.id },
      'Seed complete (password from SEED_USER_PASSWORD or the documented local default)',
    );
  } finally {
    await Promise.allSettled([prisma.$disconnect(), container.close()]);
  }
}

await main();
