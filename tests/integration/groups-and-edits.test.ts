import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFirestore,
  type FirestoreConnection,
} from '../../src/infrastructure/firestore/firestore.client.js';
import { FirestoreMessageStore } from '../../src/infrastructure/firestore/message.store.js';
import {
  createPrismaClient,
  type PrismaClient,
} from '../../src/infrastructure/postgres/prisma.client.js';
import { PrismaChatRepository } from '../../src/modules/chats/chat.repository.js';
import { PrismaUserRepository } from '../../src/modules/users/user.repository.js';

let prisma: PrismaClient;
let firestore: FirestoreConnection;
let chats: PrismaChatRepository;
let users: PrismaUserRepository;
let messages: FirestoreMessageStore;

const newUser = async () =>
  (await users.create({ name: 'G', email: `g-${randomUUID()}@example.com`, passwordHash: 'h' })).id;

beforeAll(() => {
  prisma = createPrismaClient(process.env['DATABASE_URL'] ?? '', 20);
  chats = new PrismaChatRepository(prisma);
  users = new PrismaUserRepository(prisma);
  firestore = createFirestore({
    projectId: process.env['FIREBASE_PROJECT_ID'] ?? 'demo-chat-backend',
    emulatorHost: process.env['FIRESTORE_EMULATOR_HOST'],
  });
  messages = new FirestoreMessageStore(firestore.db);
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), firestore.close()]);
});

describe('group chats (PostgreSQL)', () => {
  it('serialises concurrent member additions: no duplicates, cap never exceeded', async () => {
    const owner = await newUser();
    const candidates = await Promise.all(Array.from({ length: 6 }, () => newUser()));
    const group = await chats.createGroup(owner, 'Race', [candidates[0] ?? '']);

    // Cap of 4: owner + 3 others. Twelve concurrent requests compete for the free slots.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        chats.addMembers(group.id, [candidates[(index % 5) + 1] ?? ''], 4),
      ),
    );
    expect(results).toContain('LIMIT_EXCEEDED');
    const members = await prisma.chatMember.findMany({ where: { chatId: group.id } });
    expect(members).toHaveLength(4);
    expect(new Set(members.map((member) => member.userId)).size).toBe(4);
  });

  it('hands ownership to the earliest-joined member and deletes the chat when empty', async () => {
    const [owner, first, second] = [await newUser(), await newUser(), await newUser()];
    const group = await chats.createGroup(owner, 'Handover', [first, second]);

    await expect(chats.removeMember(group.id, owner)).resolves.toBe('REMOVED');
    const afterOwnerLeft = await chats.findById(group.id);
    // Members added together share joined_at, so the user-id tie-break decides.
    const expectedOwner = first < second ? first : second;
    const remaining = first < second ? second : first;
    expect(afterOwnerLeft?.members.find((member) => member.role === 'OWNER')?.userId).toBe(
      expectedOwner,
    );

    await chats.removeMember(group.id, expectedOwner);
    await expect(chats.removeMember(group.id, remaining)).resolves.toBe('CHAT_DELETED');
    await expect(chats.findById(group.id)).resolves.toBeNull();
    await expect(chats.removeMember(group.id, remaining)).resolves.toBe('NOT_MEMBER');
  });

  it('enforces naming and single-owner rules in the database', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO chats (id, type, name, updated_at) VALUES (${randomUUID()}::uuid, 'GROUP', NULL, now())`,
    ).rejects.toThrow();
    const [owner, other] = [await newUser(), await newUser()];
    const group = await chats.createGroup(owner, 'One owner', [other]);
    await expect(
      prisma.chatMember.updateMany({
        where: { chatId: group.id, userId: other },
        data: { role: 'OWNER' },
      }),
    ).rejects.toThrow();
  });
});

describe('message edit/delete (Firestore)', () => {
  const send = (senderId: string) =>
    messages.create({ chatId: randomUUID(), senderId, text: 'original' });

  it('edits only for the sender and records editedAt', async () => {
    const sender = randomUUID();
    const { message } = await send(sender);
    await expect(
      messages.edit(message.chatId, message.id, randomUUID(), 'hijack'),
    ).resolves.toEqual({
      status: 'NOT_SENDER',
    });
    const edited = await messages.edit(message.chatId, message.id, sender, 'updated');
    expect(edited.status).toBe('OK');
    if (edited.status !== 'OK') return;
    expect(edited.message.text).toBe('updated');
    expect(edited.message.editedAt).toBeInstanceOf(Date);
    expect(edited.message.createdAt).toEqual(message.createdAt);
  });

  it('tombstones on delete, is idempotent, and blocks later edits', async () => {
    const sender = randomUUID();
    const { message } = await send(sender);
    const deleted = await messages.softDelete(message.chatId, message.id, sender);
    expect(deleted.status).toBe('OK');
    if (deleted.status !== 'OK') return;
    expect(deleted.message).toMatchObject({ text: '', deletedAt: expect.any(Date) });

    expect((await messages.softDelete(message.chatId, message.id, sender)).status).toBe(
      'ALREADY_DELETED',
    );
    expect((await messages.edit(message.chatId, message.id, sender, 'back')).status).toBe(
      'ALREADY_DELETED',
    );
    // The tombstone keeps its place in history.
    const page = await messages.listBefore(message.chatId, 10);
    expect(page.messages.map((m) => m.id)).toEqual([message.id]);
  });

  it('never resurrects text when an edit races a delete', async () => {
    const sender = randomUUID();
    const { message } = await send(sender);
    await Promise.all([
      messages.edit(message.chatId, message.id, sender, 'racing edit'),
      messages.softDelete(message.chatId, message.id, sender),
    ]);
    const final = await messages.findById(message.chatId, message.id);
    expect(final?.deletedAt).toBeInstanceOf(Date);
    expect(final?.text).toBe('');
  });
});
