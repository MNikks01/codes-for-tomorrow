import { z } from 'zod';
import {
  AuthorizationError,
  NotFoundError,
  UnprocessableError,
} from '../../shared/errors/app-error.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination/cursor.js';
import type { UserRepository } from '../users/user.types.js';
import {
  MAX_GROUP_MEMBERS,
  type ChatMembership,
  type ChatRepository,
  type ChatView,
} from './chat.types.js';

const chatCursorSchema = z.strictObject({ t: z.iso.datetime(), id: z.uuid() });

export interface ChatPage {
  chats: ChatView[];
  nextCursor: string | null;
}

/** Membership rules live here; PostgreSQL is the authority for who belongs to a chat. */
export class ChatService {
  constructor(
    private readonly chats: ChatRepository,
    private readonly users: Pick<UserRepository, 'countExisting'>,
  ) {}

  async createOrGetDirect(
    actorId: string,
    input: { userAId: string; userBId: string },
  ): Promise<{ chat: ChatView; created: boolean }> {
    if (input.userAId === input.userBId) {
      throw new UnprocessableError('A chat requires two different users');
    }
    if (actorId !== input.userAId && actorId !== input.userBId) {
      throw new AuthorizationError('You can only create chats you participate in');
    }
    await this.assertUsersExist([input.userAId, input.userBId]);
    return this.chats.createOrGetDirect(input.userAId, input.userBId);
  }

  async createGroup(
    actorId: string,
    input: { name: string; memberIds: readonly string[] },
  ): Promise<ChatView> {
    const memberIds = [...new Set(input.memberIds)].filter((id) => id !== actorId);
    if (memberIds.length === 0) {
      throw new UnprocessableError('A group needs at least one member besides you');
    }
    if (memberIds.length + 1 > MAX_GROUP_MEMBERS) {
      throw new UnprocessableError(`A group can have at most ${MAX_GROUP_MEMBERS} members`);
    }
    await this.assertUsersExist(memberIds);
    return this.chats.createGroup(actorId, input.name, memberIds);
  }

  async renameGroup(actorId: string, chatId: string, name: string): Promise<ChatView> {
    await this.requireGroupOwner(chatId, actorId);
    await this.chats.renameGroup(chatId, name);
    return this.requireChat(chatId);
  }

  async addMembers(actorId: string, chatId: string, userIds: readonly string[]): Promise<ChatView> {
    await this.requireGroupOwner(chatId, actorId);
    const unique = [...new Set(userIds)];
    await this.assertUsersExist(unique);
    if ((await this.chats.addMembers(chatId, unique, MAX_GROUP_MEMBERS)) === 'LIMIT_EXCEEDED') {
      throw new UnprocessableError(`A group can have at most ${MAX_GROUP_MEMBERS} members`);
    }
    return this.requireChat(chatId);
  }

  /** Owners may remove anyone; every member may remove themselves (leave). */
  async removeMember(actorId: string, chatId: string, userId: string): Promise<void> {
    const membership = await this.requireGroupMembership(chatId, actorId);
    if (actorId !== userId && membership.role !== 'OWNER') {
      throw new AuthorizationError('Only the group owner can remove other members');
    }
    if ((await this.chats.removeMember(chatId, userId)) === 'NOT_MEMBER') {
      throw new NotFoundError('Member');
    }
  }

  async assertMember(chatId: string, userId: string): Promise<void> {
    toMember(await this.chats.getMembership(chatId, userId));
  }

  async listUserChats(
    actorId: string,
    userId: string,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<ChatPage> {
    if (actorId !== userId) {
      throw new AuthorizationError("You cannot list another user's chats");
    }
    const after = page.cursor ? decodeCursor(page.cursor, chatCursorSchema) : undefined;
    const result = await this.chats.listForUser(
      userId,
      page.limit,
      after ? { lastActivityAt: new Date(after.t), id: after.id } : undefined,
    );
    const last = result.chats.at(-1);
    return {
      chats: result.chats,
      nextCursor:
        result.hasMore && last
          ? encodeCursor({ t: last.lastActivityAt.toISOString(), id: last.id })
          : null,
    };
  }

  recordMessageActivity(chatId: string, messageId: string, at: Date): Promise<void> {
    return this.chats.recordMessageActivity(chatId, messageId, at);
  }

  private async requireGroupMembership(
    chatId: string,
    userId: string,
  ): Promise<Extract<ChatMembership, { status: 'MEMBER' }>> {
    const membership = toMember(await this.chats.getMembership(chatId, userId));
    if (membership.type !== 'GROUP') {
      throw new UnprocessableError('Only group chats can be managed');
    }
    return membership;
  }

  private async requireGroupOwner(chatId: string, userId: string): Promise<void> {
    if ((await this.requireGroupMembership(chatId, userId)).role !== 'OWNER') {
      throw new AuthorizationError('Only the group owner can manage this group');
    }
  }

  private async requireChat(chatId: string): Promise<ChatView> {
    const chat = await this.chats.findById(chatId);
    if (!chat) throw new NotFoundError('Chat');
    return chat;
  }

  private async assertUsersExist(ids: readonly string[]): Promise<void> {
    if ((await this.users.countExisting(ids)) !== new Set(ids).size) {
      throw new NotFoundError('User');
    }
  }
}

function toMember(membership: ChatMembership): Extract<ChatMembership, { status: 'MEMBER' }> {
  if (membership.status === 'CHAT_NOT_FOUND') throw new NotFoundError('Chat');
  if (membership.status === 'NOT_MEMBER') {
    throw new AuthorizationError('You are not a member of this chat');
  }
  return membership;
}
