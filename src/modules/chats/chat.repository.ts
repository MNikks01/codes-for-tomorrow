import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../../infrastructure/postgres/prisma.client.js';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../../infrastructure/postgres/prisma-errors.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import type { ChatListPosition, ChatMembership, ChatRepository, ChatView } from './chat.types.js';

const chatInclude = {
  members: {
    // Owner first, then by join time (enum order: OWNER < MEMBER).
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }, { userId: 'asc' }],
    select: { userId: true, role: true, joinedAt: true, user: { select: { name: true } } },
  },
} satisfies Prisma.ChatInclude;

type ChatRow = Prisma.ChatGetPayload<{ include: typeof chatInclude }>;
type Tx = Prisma.TransactionClient;

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

  async createGroup(
    ownerId: string,
    name: string,
    memberIds: readonly string[],
  ): Promise<ChatView> {
    try {
      const row = await this.prisma.chat.create({
        data: {
          type: 'GROUP',
          name,
          members: {
            create: [
              { userId: ownerId, role: 'OWNER' },
              ...memberIds.map((userId) => ({ userId, role: 'MEMBER' as const })),
            ],
          },
        },
        include: chatInclude,
      });
      return toChatView(row);
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new NotFoundError('User');
      throw error;
    }
  }

  async findById(chatId: string): Promise<ChatView | null> {
    const row = await this.prisma.chat.findUnique({ where: { id: chatId }, include: chatInclude });
    return row ? toChatView(row) : null;
  }

  async getMembership(chatId: string, userId: string): Promise<ChatMembership> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { type: true, members: { where: { userId }, select: { role: true } } },
    });
    if (!chat) return { status: 'CHAT_NOT_FOUND' };
    const member = chat.members[0];
    return member
      ? { status: 'MEMBER', type: chat.type, role: member.role }
      : { status: 'NOT_MEMBER', type: chat.type };
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

  async renameGroup(chatId: string, name: string): Promise<void> {
    await this.prisma.chat.update({ where: { id: chatId }, data: { name } });
  }

  async addMembers(
    chatId: string,
    userIds: readonly string[],
    maxMembers: number,
  ): Promise<'ADDED' | 'LIMIT_EXCEEDED'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockChat(tx, chatId);
        const existing = await tx.chatMember.findMany({
          where: { chatId },
          select: { userId: true },
        });
        const current = new Set(existing.map((member) => member.userId));
        const toAdd = userIds.filter((userId) => !current.has(userId));
        if (current.size + toAdd.length > maxMembers) return 'LIMIT_EXCEEDED';
        await tx.chatMember.createMany({
          data: toAdd.map((userId) => ({ chatId, userId })),
          skipDuplicates: true,
        });
        return 'ADDED';
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new NotFoundError('User');
      throw error;
    }
  }

  removeMember(chatId: string, userId: string): Promise<'REMOVED' | 'NOT_MEMBER' | 'CHAT_DELETED'> {
    return this.prisma.$transaction(async (tx) => {
      await lockChat(tx, chatId);
      const member = await tx.chatMember.findUnique({
        where: { chatId_userId: { chatId, userId } },
        select: { id: true, role: true },
      });
      if (!member) return 'NOT_MEMBER';
      await tx.chatMember.delete({ where: { id: member.id } });

      const successor = await tx.chatMember.findFirst({
        where: { chatId },
        orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
        select: { id: true },
      });
      if (!successor) {
        // Firestore messages of a deleted chat become unreachable (no membership can exist).
        await tx.chat.delete({ where: { id: chatId } });
        return 'CHAT_DELETED';
      }
      if (member.role === 'OWNER') {
        await tx.chatMember.update({ where: { id: successor.id }, data: { role: 'OWNER' } });
      }
      return 'REMOVED';
    });
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

/** Serialises membership changes per chat so size limits and ownership hand-over stay correct. */
async function lockChat(tx: Tx, chatId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId}::uuid FOR UPDATE`;
}

function toChatView(row: ChatRow): ChatView {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    members: row.members.map((member) => ({
      userId: member.userId,
      name: member.user.name,
      role: member.role,
      joinedAt: member.joinedAt,
    })),
    lastMessageId: row.lastMessageId,
    lastMessageAt: row.lastMessageAt,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
