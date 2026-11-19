import { z } from 'zod';
import {
  AuthorizationError,
  NotFoundError,
  UnprocessableError,
} from '../../shared/errors/app-error.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination/cursor.js';
import type { UserRepository } from '../users/user.types.js';
import type { ChatRepository, ChatView } from './chat.types.js';

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
    if ((await this.users.countExisting([input.userAId, input.userBId])) !== 2) {
      throw new NotFoundError('User');
    }
    return this.chats.createOrGetDirect(input.userAId, input.userBId);
  }

  async assertMember(chatId: string, userId: string): Promise<void> {
    const access = await this.chats.getAccess(chatId, userId);
    if (access === 'CHAT_NOT_FOUND') throw new NotFoundError('Chat');
    if (access === 'NOT_MEMBER') throw new AuthorizationError('You are not a member of this chat');
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
}
