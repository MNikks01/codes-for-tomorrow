import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  type PrismaClient,
} from '../../src/infrastructure/postgres/prisma.client.js';
import { PrismaRefreshTokenRepository } from '../../src/modules/auth/auth.repository.js';
import { PrismaChatRepository } from '../../src/modules/chats/chat.repository.js';
import { PrismaUserRepository } from '../../src/modules/users/user.repository.js';
import { ConflictError } from '../../src/shared/errors/app-error.js';

let prisma: PrismaClient;
let users: PrismaUserRepository;
let chats: PrismaChatRepository;

const newUser = () =>
  users.create({ name: 'IT User', email: `it-${randomUUID()}@example.com`, passwordHash: 'h' });

beforeAll(() => {
  prisma = createPrismaClient(process.env['DATABASE_URL'] ?? '', 20);
  users = new PrismaUserRepository(prisma);
  chats = new PrismaChatRepository(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PrismaUserRepository', () => {
  it('enforces unique emails at the database level', async () => {
    const user = await newUser();
    await expect(
      users.create({ name: 'Dup', email: user.email, passwordHash: 'h' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('counts distinct existing ids only', async () => {
    const user = await newUser();
    await expect(users.countExisting([user.id, user.id, randomUUID()])).resolves.toBe(1);
  });
});

describe('PrismaChatRepository', () => {
  it('creates exactly one direct chat under heavy concurrency', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        index % 2 === 0 ? chats.createOrGetDirect(a.id, b.id) : chats.createOrGetDirect(b.id, a.id),
      ),
    );
    const ids = new Set(results.map((result) => result.chat.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);

    const rows = await prisma.chatMember.findMany({ where: { chatId: [...ids][0] ?? '' } });
    expect(rows.map((row) => row.userId).sort()).toEqual([a.id, b.id].sort());
  });

  it('rejects a DIRECT chat without a pair key (CHECK constraint)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO chats (id, type, direct_key, updated_at) VALUES (${randomUUID()}::uuid, 'DIRECT', NULL, now())`,
    ).rejects.toThrow();
  });

  it('reports membership precisely', async () => {
    const [a, b, outsider] = await Promise.all([newUser(), newUser(), newUser()]);
    const { chat } = await chats.createOrGetDirect(a.id, b.id);
    await expect(chats.getMembership(chat.id, a.id)).resolves.toEqual({
      status: 'MEMBER',
      type: 'DIRECT',
      role: 'MEMBER',
    });
    await expect(chats.getMembership(chat.id, outsider.id)).resolves.toEqual({
      status: 'NOT_MEMBER',
      type: 'DIRECT',
    });
    await expect(chats.getMembership(randomUUID(), a.id)).resolves.toEqual({
      status: 'CHAT_NOT_FOUND',
    });
  });

  it('lists by recent activity with stable keyset pagination', async () => {
    const owner = await newUser();
    const partners = await Promise.all(Array.from({ length: 5 }, () => newUser()));
    const created = [];
    for (const partner of partners) {
      created.push((await chats.createOrGetDirect(owner.id, partner.id)).chat);
    }
    // Make the oldest chat the most recently active.
    const bumped = created[0];
    if (!bumped) throw new Error('setup failed');
    await chats.recordMessageActivity(bumped.id, 'msg-1', new Date(Date.now() + 60_000));

    const seen: string[] = [];
    let after: { lastActivityAt: Date; id: string } | undefined;
    for (;;) {
      const page = await chats.listForUser(owner.id, 2, after);
      seen.push(...page.chats.map((chat) => chat.id));
      const last = page.chats.at(-1);
      if (!page.hasMore || !last) break;
      after = { lastActivityAt: last.lastActivityAt, id: last.id };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen[0]).toBe(bumped.id);
  });

  it('never moves chat activity backwards', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const { chat } = await chats.createOrGetDirect(a.id, b.id);
    const newer = new Date('2030-01-01T00:00:01.000Z');
    await chats.recordMessageActivity(chat.id, 'newer', newer);
    await chats.recordMessageActivity(chat.id, 'older', new Date('2030-01-01T00:00:00.000Z'));
    const row = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(row.lastMessageId).toBe('newer');
    expect(row.lastActivityAt.toISOString()).toBe(newer.toISOString());
  });
});

describe('PrismaRefreshTokenRepository', () => {
  it('lets exactly one concurrent rotation win and stores exactly one successor', async () => {
    const repository = new PrismaRefreshTokenRepository(prisma);
    const user = await newUser();
    const familyId = randomUUID();
    const hash = () => randomUUID().replaceAll('-', '').padEnd(64, '0');
    const expiresAt = new Date(Date.now() + 86_400_000);
    const tokenHash = hash();
    await repository.create({ userId: user.id, tokenHash, familyId, expiresAt });
    const record = await repository.findByHash(tokenHash);
    if (!record) throw new Error('token not stored');

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.rotate(record.id, new Date(), {
          userId: user.id,
          tokenHash: hash(),
          familyId,
          expiresAt,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(prisma.refreshToken.count({ where: { familyId } })).resolves.toBe(2);
  });

  it('deletes only expired tokens', async () => {
    const repository = new PrismaRefreshTokenRepository(prisma);
    const user = await newUser();
    const base = { userId: user.id, familyId: randomUUID() };
    await prisma.refreshToken.create({
      data: {
        ...base,
        tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '1'),
        createdAt: new Date('2020-01-01T00:00:00Z'),
        expiresAt: new Date('2020-02-01T00:00:00Z'),
      },
    });
    await repository.create({
      ...base,
      tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '2'),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await repository.deleteExpired(user.id, new Date());
    await expect(prisma.refreshToken.count({ where: { userId: user.id } })).resolves.toBe(1);
  });
});
