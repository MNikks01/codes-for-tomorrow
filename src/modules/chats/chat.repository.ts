import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../../infrastructure/postgres/prisma.client.js';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../../infrastructure/postgres/prisma-errors.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import type { ChatAccess, ChatListPosition, ChatRepository, ChatView } from './chat.types.js';

const chatInclude = {
  members: {
    orderBy: { joinedAt: 'asc' },
    select: { userId: true, joinedAt: true, user: { select: { name: true } } },
  },
} satisfies Prisma.ChatInclude;

type ChatRow = Prisma.ChatGetPayload<{ include: typeof chatInclude }>;

/** Canonical key for an unordered pair: both orderings map to the same unique value. */
export function directChatKey(userAId: string, userBId: string): string {
  return userAId < userBId ? `${userAId}:${userBId}` : `${userBId}:${userAId}`;
}

export class PrismaChatRepository implements ChatRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createOrGetDirect(
    userAId: string,
    userBId: string,
  ): Promise<{ chat: ChatView; created: boolean }> {
    const directKey = directChatKey(userAId, userBId);
    const existing = await this.findByDirectKey(directKey);
    if (existing) return { chat: existing, created: false };

    try {
      // Chat + both memberships are inserted in one transaction by the nested create.
      const row = await this.prisma.chat.create({
        data: {
          type: 'DIRECT',
          directKey,
          members: { create: [{ userId: userAId }, { userId: userBId }] },
        },
        include: chatInclude,
      });
      return { chat: toChatView(row), created: true };
    } catch (error) {
      // A participant was deleted after the service checked it existed.
      if (isForeignKeyViolation(error)) throw new NotFoundError('User');
      // A concurrent request inserted the same pair first; the UNIQUE index rejected ours.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findByDirectKey(directKey);
      if (!winner) throw error;
      return { chat: winner, created: false };
    }
  }

  async getAccess(chatId: string, userId: string): Promise<ChatAccess> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { members: { where: { userId }, select: { id: true } } },
    });
    if (!chat) return 'CHAT_NOT_FOUND';
    return chat.members.length > 0 ? 'MEMBER' : 'NOT_MEMBER';
  }

  async listForUser(
    userId: string,
    limit: number,
    after?: ChatListPosition,
  ): Promise<{ chats: ChatView[]; hasMore: boolean }> {
    const rows = await this.prisma.chat.findMany({
      where: {
        members: { some: { userId } },
        ...(after
          ? {
              OR: [
                { lastActivityAt: { lt: after.lastActivityAt } },
                { lastActivityAt: after.lastActivityAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: chatInclude,
    });
    return { chats: rows.slice(0, limit).map(toChatView), hasMore: rows.length > limit };
  }

  async recordMessageActivity(chatId: string, messageId: string, at: Date): Promise<void> {
    await this.prisma.chat.updateMany({
      where: { id: chatId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }] },
      data: { lastMessageId: messageId, lastMessageAt: at, lastActivityAt: at },
    });
  }

  private async findByDirectKey(directKey: string): Promise<ChatView | null> {
    const row = await this.prisma.chat.findUnique({ where: { directKey }, include: chatInclude });
    return row ? toChatView(row) : null;
  }
}

function toChatView(row: ChatRow): ChatView {
  return {
    id: row.id,
    type: row.type,
    members: row.members.map((member) => ({
      userId: member.userId,
      name: member.user.name,
      joinedAt: member.joinedAt,
    })),
    lastMessageId: row.lastMessageId,
    lastMessageAt: row.lastMessageAt,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
