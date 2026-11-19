import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ChatService } from '../../src/modules/chats/chat.service.js';
import { MAX_GROUP_MEMBERS } from '../../src/modules/chats/chat.types.js';
import { MessageService } from '../../src/modules/messages/message.service.js';
import type { MessageStore } from '../../src/modules/messages/message.types.js';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../src/shared/errors/app-error.js';
import { InMemoryChatRepository, InMemoryUserRepository, makeMessage } from '../fixtures/fakes.js';

describe('ChatService group management', () => {
  let chats: InMemoryChatRepository;
  let users: InMemoryUserRepository;
  let service: ChatService;
  let owner: string;
  let alice: string;
  let bob: string;

  const newUser = async () =>
    (await users.create({ name: 'u', email: `${randomUUID()}@x.io`, passwordHash: 'h' })).id;

  beforeEach(async () => {
    chats = new InMemoryChatRepository();
    users = new InMemoryUserRepository();
    service = new ChatService(chats, users);
    [owner, alice, bob] = [await newUser(), await newUser(), await newUser()];
  });

  describe('createGroup', () => {
    it('makes the creator owner, de-duplicates members and ignores the creator in the list', async () => {
      const chat = await service.createGroup(owner, {
        name: 'Team',
        memberIds: [alice, alice, owner, bob],
      });
      expect(chat).toMatchObject({ type: 'GROUP', name: 'Team' });
      expect(chat.members.map((member) => [member.userId, member.role])).toEqual([
        [owner, 'OWNER'],
        [alice, 'MEMBER'],
        [bob, 'MEMBER'],
      ]);
    });

    it('requires at least one other member and respects the size cap', async () => {
      await expect(
        service.createGroup(owner, { name: 'Solo', memberIds: [owner] }),
      ).rejects.toBeInstanceOf(UnprocessableError);
      const tooMany = Array.from({ length: MAX_GROUP_MEMBERS }, () => randomUUID());
      await expect(
        service.createGroup(owner, { name: 'Big', memberIds: tooMany }),
      ).rejects.toBeInstanceOf(UnprocessableError);
    });

    it('rejects unknown users', async () => {
      await expect(
        service.createGroup(owner, { name: 'X', memberIds: [alice, randomUUID()] }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('owner-only operations', () => {
    it('lets the owner rename and add members', async () => {
      const group = await service.createGroup(owner, { name: 'Old', memberIds: [alice] });
      expect((await service.renameGroup(owner, group.id, 'New')).name).toBe('New');
      const updated = await service.addMembers(owner, group.id, [bob, alice]);
      expect(updated.members.map((member) => member.userId)).toEqual([owner, alice, bob]);
    });

    it('forbids members, rejects direct chats and enforces the cap', async () => {
      const group = await service.createGroup(owner, { name: 'G', memberIds: [alice] });
      await expect(service.renameGroup(alice, group.id, 'Mine')).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(service.addMembers(alice, group.id, [bob])).rejects.toBeInstanceOf(
        AuthorizationError,
      );

      const { chat: direct } = await service.createOrGetDirect(owner, {
        userAId: owner,
        userBId: alice,
      });
      await expect(service.renameGroup(owner, direct.id, 'No')).rejects.toBeInstanceOf(
        UnprocessableError,
      );

      vi.spyOn(chats, 'addMembers').mockResolvedValue('LIMIT_EXCEEDED');
      await expect(service.addMembers(owner, group.id, [bob])).rejects.toBeInstanceOf(
        UnprocessableError,
      );
    });
  });

  describe('removeMember', () => {
    it('lets members leave and hands ownership over when the owner leaves', async () => {
      const group = await service.createGroup(owner, { name: 'G', memberIds: [alice, bob] });
      await service.removeMember(bob, group.id, bob);
      await service.removeMember(owner, group.id, owner);
      const remaining = chats.chats.get(group.id)?.members;
      expect(remaining?.map((member) => [member.userId, member.role])).toEqual([[alice, 'OWNER']]);
    });

    it('only lets the owner remove others, and 404s for non-members', async () => {
      const group = await service.createGroup(owner, { name: 'G', memberIds: [alice, bob] });
      await expect(service.removeMember(alice, group.id, bob)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await service.removeMember(owner, group.id, bob);
      await expect(service.removeMember(owner, group.id, bob)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});

describe('MessageService edit/delete', () => {
  const sender = randomUUID();
  let store: { [K in keyof MessageStore]: Mock<MessageStore[K]> };
  let service: MessageService;
  let chatId: string;

  beforeEach(() => {
    const chats = new InMemoryChatRepository();
    chatId = chats.addChat([sender, randomUUID()]).id;
    store = {
      create: vi.fn(),
      findById: vi.fn(),
      listBefore: vi.fn(),
      edit: vi.fn(),
      softDelete: vi.fn(),
    };
    service = new MessageService(
      new ChatService(chats, new InMemoryUserRepository()),
      store,
      { markRead: vi.fn() },
      { advance: vi.fn() },
      { warn: vi.fn() },
    );
  });

  it('maps edit outcomes to results and errors', async () => {
    const message = makeMessage({ chatId, senderId: sender });
    store.edit.mockResolvedValueOnce({ status: 'OK', message });
    await expect(service.edit(sender, chatId, message.id, 'new')).resolves.toBe(message);

    store.edit.mockResolvedValueOnce({ status: 'ALREADY_DELETED', message });
    await expect(service.edit(sender, chatId, message.id, 'x')).rejects.toBeInstanceOf(
      ConflictError,
    );
    store.edit.mockResolvedValueOnce({ status: 'NOT_SENDER' });
    await expect(service.edit(sender, chatId, message.id, 'x')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    store.edit.mockResolvedValueOnce({ status: 'NOT_FOUND' });
    await expect(service.edit(sender, chatId, message.id, 'x')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('treats deleting an already deleted message as success', async () => {
    const message = makeMessage({ chatId, senderId: sender });
    store.softDelete.mockResolvedValueOnce({ status: 'ALREADY_DELETED', message });
    await expect(service.delete(sender, chatId, message.id)).resolves.toBeUndefined();
    store.softDelete.mockResolvedValueOnce({ status: 'NOT_SENDER' });
    await expect(service.delete(sender, chatId, message.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('checks membership before touching Firestore', async () => {
    await expect(service.edit(randomUUID(), chatId, 'm', 'x')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(service.delete(randomUUID(), chatId, 'm')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(store.edit).not.toHaveBeenCalled();
    expect(store.softDelete).not.toHaveBeenCalled();
  });
});
