export type ChatType = 'DIRECT' | 'GROUP';

export interface ChatMemberView {
  userId: string;
  name: string;
  joinedAt: Date;
}

export interface ChatView {
  id: string;
  type: ChatType;
  members: ChatMemberView[];
  lastMessageId: string | null;
  lastMessageAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ChatAccess = 'MEMBER' | 'NOT_MEMBER' | 'CHAT_NOT_FOUND';

/** Keyset position for listing chats by most recent activity. */
export interface ChatListPosition {
  lastActivityAt: Date;
  id: string;
}

export interface ChatRepository {
  createOrGetDirect(
    userAId: string,
    userBId: string,
  ): Promise<{ chat: ChatView; created: boolean }>;
  getAccess(chatId: string, userId: string): Promise<ChatAccess>;
  listForUser(
    userId: string,
    limit: number,
    after?: ChatListPosition,
  ): Promise<{ chats: ChatView[]; hasMore: boolean }>;
  /** Moves chat activity forward only; never rewinds it. */
  recordMessageActivity(chatId: string, messageId: string, at: Date): Promise<void>;
}

export interface ChatDto {
  chatId: string;
  type: ChatType;
  memberIds: string[];
  members: ChatMemberView[];
  lastMessageId: string | null;
  lastMessageAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function toChatDto(chat: ChatView): ChatDto {
  return {
    chatId: chat.id,
    type: chat.type,
    memberIds: chat.members.map((member) => member.userId),
    members: chat.members,
    lastMessageId: chat.lastMessageId,
    lastMessageAt: chat.lastMessageAt,
    lastActivityAt: chat.lastActivityAt,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}
