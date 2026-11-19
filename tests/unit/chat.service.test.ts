import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { directChatKey } from '../../src/modules/chats/chat.repository.js';
import { ChatService } from '../../src/modules/chats/chat.service.js';
import {
  AuthorizationError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../src/shared/errors/app-error.js';
import { encodeCursor } from '../../src/shared/pagination/cursor.js';
import { InMemoryChatRepository, InMemoryUserRepository } from '../fixtures/fakes.js';

describe('ChatService', () => {
  let chats: InMemoryChatRepository;
  let users: InMemoryUserRepository;
  let service: ChatService;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    chats = new InMemoryChatRepository();
    users = new InMemoryUserRepository();
    service = new ChatService(chats, users);
    alice = (await users.create({ name: 'A', email: 'a@x.io', passwordHash: 'h' })).id;
    bob = (await users.create({ name: 'B', email: 'b@x.io', passwordHash: 'h' })).id;
  });

  describe('createOrGetDirect', () => {
    it('creates a chat when the actor is a participant', async () => {
      const result = await service.createOrGetDirect(alice, { userAId: alice, userBId: bob });
      expect(result.created).toBe(true);
      expect(result.chat.members.map((member) => member.userId).sort()).toEqual(
        [alice, bob].sort(),
      );
    });

    it('returns the existing chat regardless of argument order', async () => {
      const first = await service.createOrGetDirect(alice, { userAId: alice, userBId: bob });
      const second = await service.createOrGetDirect(bob, { userAId: bob, userBId: alice });
      expect(second).toEqual({ chat: first.chat, created: false });
    });

    it('rejects chatting with yourself', async () => {
      await expect(
        service.createOrGetDirect(alice, { userAId: alice, userBId: alice }),
      ).rejects.toBeInstanceOf(UnprocessableError);
    });

    it('rejects creating a chat for two other users', async () => {
      const carol = (await users.create({ name: 'C', email: 'c@x.io', passwordHash: 'h' })).id;
      await expect(
        service.createOrGetDirect(carol, { userAId: alice, userBId: bob }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it('rejects unknown users', async () => {
      await expect(
        service.createOrGetDirect(alice, { userAId: alice, userBId: randomUUID() }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('assertMember', () => {
    it('passes for members, 403s non-members, 404s missing chats', async () => {
      const chat = chats.addChat([alice, bob]);
      await expect(service.assertMember(chat.id, alice)).resolves.toBeUndefined();
      await expect(service.assertMember(chat.id, randomUUID())).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(service.assertMember(randomUUID(), alice)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('listUserChats', () => {
    it("forbids listing another user's chats", async () => {
      await expect(service.listUserChats(alice, bob, { limit: 10 })).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it('pages by most recent activity without duplicates or gaps', async () => {
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      const created = Array.from({ length: 5 }, (_, index) =>
        chats.addChat([alice, randomUUID()], new Date(base + index * 1000)),
      );
      // Two chats share a timestamp to exercise the id tie-breaker.
      created.push(chats.addChat([alice, randomUUID()], new Date(base + 4000)));

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.listUserChats(alice, alice, { limit: 2, cursor });
        seen.push(...page.chats.map((chat) => chat.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
      const times = seen.map((id) => chats.chats.get(id)?.lastActivityAt.getTime() ?? 0);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('returns a null cursor on the last page', async () => {
      chats.addChat([alice, bob]);
      const page = await service.listUserChats(alice, alice, { limit: 5 });
      expect(page.nextCursor).toBeNull();
    });

    it('rejects malformed or tampered cursors', async () => {
      await expect(
        service.listUserChats(alice, alice, { limit: 5, cursor: 'not-base64-json' }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        service.listUserChats(alice, alice, {
          limit: 5,
          cursor: encodeCursor({ t: 'yesterday', id: 'x' }),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('delegates activity recording to the repository', async () => {
    const at = new Date();
    await service.recordMessageActivity('c', 'm', at);
    expect(chats.activityCalls).toEqual([{ chatId: 'c', messageId: 'm', at }]);
  });

  it('builds the same canonical direct-chat key for either ordering', () => {
    expect(directChatKey(alice, bob)).toBe(directChatKey(bob, alice));
    expect(directChatKey(alice, bob).split(':')).toEqual([alice, bob].sort());
  });
});
