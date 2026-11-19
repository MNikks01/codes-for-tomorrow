import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ChatService } from '../../src/modules/chats/chat.service.js';
import { MessageService } from '../../src/modules/messages/message.service.js';
import type {
  LastSeenStore,
  Message,
  MessageStore,
  ReceiptStore,
} from '../../src/modules/messages/message.types.js';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from '../../src/shared/errors/app-error.js';
import { InMemoryChatRepository, InMemoryUserRepository, makeMessage } from '../fixtures/fakes.js';

describe('MessageService', () => {
  let chats: InMemoryChatRepository;
  let messageStore: {
    create: Mock<MessageStore['create']>;
    findById: Mock<MessageStore['findById']>;
    listBefore: Mock<MessageStore['listBefore']>;
  };
  let markRead: Mock<ReceiptStore['markRead']>;
  let advance: Mock<LastSeenStore['advance']>;
  let logger: { warn: Mock };
  let service: MessageService;
  let alice: string;
  let bob: string;
  let chatId: string;

  beforeEach(() => {
    chats = new InMemoryChatRepository();
    alice = randomUUID();
    bob = randomUUID();
    chatId = chats.addChat([alice, bob]).id;
    messageStore = { create: vi.fn(), findById: vi.fn(), listBefore: vi.fn() };
    markRead = vi.fn();
    advance = vi.fn();
    logger = { warn: vi.fn() };
    const chatService = new ChatService(chats, new InMemoryUserRepository());
    service = new MessageService(chatService, messageStore, { markRead }, { advance }, logger);
  });

  describe('send', () => {
    it('stores the message as the authenticated user and records chat activity', async () => {
      const message = makeMessage({ chatId, senderId: alice });
      messageStore.create.mockResolvedValue({ message, created: true });

      const result = await service.send(alice, chatId, { text: 'hi', idempotencyKey: 'key-12345' });

      expect(result.created).toBe(true);
      expect(messageStore.create).toHaveBeenCalledWith({
        chatId,
        senderId: alice,
        text: 'hi',
        idempotencyKey: 'key-12345',
      });
      expect(chats.activityCalls).toEqual([
        { chatId, messageId: message.id, at: message.createdAt },
      ]);
    });

    it('rejects a senderId that differs from the authenticated user', async () => {
      await expect(
        service.send(alice, chatId, { senderId: bob, text: 'hi' }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(messageStore.create).not.toHaveBeenCalled();
    });

    it('rejects non-members before touching Firestore', async () => {
      await expect(service.send(randomUUID(), chatId, { text: 'hi' })).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(service.send(alice, randomUUID(), { text: 'hi' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(messageStore.create).not.toHaveBeenCalled();
    });

    it('still succeeds when the PostgreSQL activity sync fails, and logs it', async () => {
      const message = makeMessage({ chatId, senderId: alice });
      messageStore.create.mockResolvedValue({ message, created: true });
      vi.spyOn(chats, 'recordMessageActivity').mockRejectedValue(new Error('db down'));

      await expect(service.send(alice, chatId, { text: 'hi' })).resolves.toMatchObject({
        created: true,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'chat_activity_sync_failed', messageId: message.id }),
        expect.any(String),
      );
    });

    it('re-syncs activity on idempotent replays so retries heal failed syncs', async () => {
      const message = makeMessage({ chatId, senderId: alice });
      messageStore.create.mockResolvedValue({ message, created: false });
      await service.send(alice, chatId, { text: 'hi', idempotencyKey: 'key-12345' });
      expect(chats.activityCalls).toHaveLength(1);
    });
  });

  describe('list', () => {
    const page = (count: number): Message[] =>
      Array.from({ length: count }, (_, index) =>
        makeMessage({ chatId, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 10 - index)) }),
      );

    it('returns chronological order and a cursor built from the oldest message', async () => {
      const newestFirst = page(3);
      messageStore.listBefore.mockResolvedValue({ messages: newestFirst, hasMore: true });

      const result = await service.list(alice, chatId, { limit: 3 });

      expect(result.messages.map((message) => message.id)).toEqual(
        [...newestFirst].reverse().map((message) => message.id),
      );
      expect(result.nextCursor).not.toBeNull();

      messageStore.listBefore.mockResolvedValue({ messages: [], hasMore: false });
      await service.list(alice, chatId, { limit: 3, cursor: result.nextCursor ?? undefined });
      const oldest = newestFirst[2];
      expect(messageStore.listBefore).toHaveBeenLastCalledWith(chatId, 3, oldest?.position);
    });

    it('returns a null cursor when there are no older messages', async () => {
      messageStore.listBefore.mockResolvedValue({ messages: page(2), hasMore: false });
      expect((await service.list(alice, chatId, { limit: 5 })).nextCursor).toBeNull();
    });

    it('rejects cursors outside the Firestore timestamp range with a 400, not a 500', async () => {
      const cursor = Buffer.from(JSON.stringify({ s: 9e12, n: 0, id: 'abc' })).toString(
        'base64url',
      );
      await expect(service.list(alice, chatId, { limit: 5, cursor })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(messageStore.listBefore).not.toHaveBeenCalled();
    });

    it('rejects invalid cursors and non-members', async () => {
      await expect(service.list(alice, chatId, { limit: 5, cursor: '%%%' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(service.list(randomUUID(), chatId, { limit: 5 })).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });
  });

  describe('markRead', () => {
    it('records a receipt for the authenticated user', async () => {
      messageStore.findById.mockResolvedValue(makeMessage({ chatId }));
      markRead.mockResolvedValue({
        receipt: { chatId, messageId: 'msg-1', userId: alice, readAt: new Date() },
        created: true,
      });
      await service.markRead(alice, chatId, 'msg-1');
      expect(markRead).toHaveBeenCalledWith(chatId, 'msg-1', alice);
    });

    it('404s when the message does not exist in this chat', async () => {
      messageStore.findById.mockResolvedValue(null);
      await expect(service.markRead(alice, chatId, 'missing')).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(markRead).not.toHaveBeenCalled();
    });

    it('forbids marking on behalf of someone else', async () => {
      await expect(service.markRead(alice, chatId, 'msg-1', bob)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });
  });

  describe('updateLastSeen', () => {
    it('passes the resolved message to the store', async () => {
      const message = makeMessage({ chatId });
      messageStore.findById.mockResolvedValue(message);
      advance.mockResolvedValue({
        lastSeen: {
          chatId,
          userId: alice,
          messageId: message.id,
          messageCreatedAt: message.createdAt,
          lastSeenAt: new Date(),
        },
        updated: true,
      });
      await service.updateLastSeen(alice, chatId, { messageId: message.id, userId: alice });
      expect(advance).toHaveBeenCalledWith(chatId, alice, message);
    });

    it('rejects unknown messages and impersonation', async () => {
      messageStore.findById.mockResolvedValue(null);
      await expect(
        service.updateLastSeen(alice, chatId, { messageId: 'nope' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        service.updateLastSeen(alice, chatId, { messageId: 'x', userId: bob }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });
});
