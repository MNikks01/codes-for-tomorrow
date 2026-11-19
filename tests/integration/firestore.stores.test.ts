import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFirestore,
  type FirestoreConnection,
} from '../../src/infrastructure/firestore/firestore.client.js';
import { FirestoreLastSeenStore } from '../../src/infrastructure/firestore/last-seen.store.js';
import { FirestoreMessageStore } from '../../src/infrastructure/firestore/message.store.js';
import { FirestoreReceiptStore } from '../../src/infrastructure/firestore/receipt.store.js';
import type { Message } from '../../src/modules/messages/message.types.js';
import { ConflictError } from '../../src/shared/errors/app-error.js';

let firestore: FirestoreConnection;
let messages: FirestoreMessageStore;
let receipts: FirestoreReceiptStore;
let lastSeen: FirestoreLastSeenStore;

beforeAll(() => {
  firestore = createFirestore({
    projectId: process.env['FIREBASE_PROJECT_ID'] ?? 'demo-chat-backend',
    emulatorHost: process.env['FIRESTORE_EMULATOR_HOST'],
  });
  messages = new FirestoreMessageStore(firestore.db);
  receipts = new FirestoreReceiptStore(firestore.db);
  lastSeen = new FirestoreLastSeenStore(firestore.db);
});

afterAll(async () => {
  await firestore.close();
});

const send = (chatId: string, text: string, idempotencyKey?: string) =>
  messages.create({ chatId, senderId: randomUUID(), text, idempotencyKey });

describe('FirestoreMessageStore', () => {
  it('stores messages with server-generated timestamps', async () => {
    const before = Date.now();
    const { message, created } = await send(randomUUID(), 'hello');
    expect(created).toBe(true);
    expect(message.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(message.position.id).toBe(message.id);

    const raw = (
      await firestore.db.doc(`chats/${message.chatId}/messages/${message.id}`).get()
    ).data();
    expect(raw).toMatchObject({ text: 'hello', chatId: message.chatId, deletedAt: null });
  });

  it('deduplicates concurrent retries that share an idempotency key', async () => {
    const chatId = randomUUID();
    const senderId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        messages.create({ chatId, senderId, text: 'once', idempotencyKey: 'retry-key-1' }),
      ),
    );
    expect(new Set(results.map((result) => result.message.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const snapshot = await firestore.db.collection(`chats/${chatId}/messages`).get();
    expect(snapshot.size).toBe(1);
  });

  it('rejects reuse of an idempotency key for different content', async () => {
    const chatId = randomUUID();
    const senderId = randomUUID();
    await messages.create({ chatId, senderId, text: 'first', idempotencyKey: 'key-reused-1' });
    await expect(
      messages.create({ chatId, senderId, text: 'second', idempotencyKey: 'key-reused-1' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('scopes idempotency keys per sender', async () => {
    const chatId = randomUUID();
    const a = await messages.create({
      chatId,
      senderId: randomUUID(),
      text: 'x',
      idempotencyKey: 'shared-key-1',
    });
    const b = await messages.create({
      chatId,
      senderId: randomUUID(),
      text: 'x',
      idempotencyKey: 'shared-key-1',
    });
    expect(a.message.id).not.toBe(b.message.id);
  });

  it('pages newest-first without duplicates or gaps', async () => {
    const chatId = randomUUID();
    const sent: Message[] = [];
    for (let index = 0; index < 7; index += 1) {
      sent.push((await send(chatId, `m${index}`)).message);
    }
    const seen: Message[] = [];
    let before: Message['position'] | undefined;
    for (;;) {
      const page = await messages.listBefore(chatId, 3, before);
      seen.push(...page.messages);
      const oldest = page.messages.at(-1);
      if (!page.hasMore || !oldest) break;
      before = oldest.position;
    }
    expect(seen.map((message) => message.text)).toEqual(
      [...sent].reverse().map((message) => message.text),
    );
  });

  it('returns null for messages outside the requested chat', async () => {
    const { message } = await send(randomUUID(), 'private');
    await expect(messages.findById(randomUUID(), message.id)).resolves.toBeNull();
  });
});

describe('FirestoreReceiptStore', () => {
  it('creates one receipt per user even under concurrent duplicate requests', async () => {
    const { message } = await send(randomUUID(), 'read me');
    const userId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => receipts.markRead(message.chatId, message.id, userId)),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.receipt.readAt.getTime())).size).toBe(1);
    const snapshot = await firestore.db
      .collection(`chats/${message.chatId}/messages/${message.id}/readReceipts`)
      .get();
    expect(snapshot.size).toBe(1);
  });
});

describe('FirestoreLastSeenStore', () => {
  it('moves forward, ignores older messages, and stays correct under concurrency', async () => {
    const chatId = randomUUID();
    const userId = randomUUID();
    const ordered: Message[] = [];
    for (let index = 0; index < 4; index += 1) {
      ordered.push((await send(chatId, `m${index}`)).message);
    }
    const [first, second, third, fourth] = ordered;
    if (!first || !second || !third || !fourth) throw new Error('setup failed');

    expect((await lastSeen.advance(chatId, userId, second)).updated).toBe(true);
    const backwards = await lastSeen.advance(chatId, userId, first);
    expect(backwards.updated).toBe(false);
    expect(backwards.lastSeen.messageId).toBe(second.id);

    await Promise.all([
      lastSeen.advance(chatId, userId, third),
      lastSeen.advance(chatId, userId, fourth),
      lastSeen.advance(chatId, userId, first),
    ]);
    const final = await lastSeen.advance(chatId, userId, first);
    expect(final.lastSeen.messageId).toBe(fourth.id);
  });
});
