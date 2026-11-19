export type ChatType = 'DIRECT' | 'GROUP';
export type MemberRole = 'OWNER' | 'MEMBER';

/** Hard cap on group size: keeps member lists and fan-out bounded. */
export const MAX_GROUP_MEMBERS = 100;

export interface ChatMemberView {
  userId: string;
  name: string;
  role: MemberRole;
  joinedAt: Date;
}

export interface ChatView {
  id: string;
  type: ChatType;
  name: string | null;
  members: ChatMemberView[];
  lastMessageId: string | null;
  lastMessageAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ChatMembership =
  | { status: 'CHAT_NOT_FOUND' }
  | { status: 'NOT_MEMBER'; type: ChatType }
  | { status: 'MEMBER'; type: ChatType; role: MemberRole };

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
  createGroup(ownerId: string, name: string, memberIds: readonly string[]): Promise<ChatView>;
  findById(chatId: string): Promise<ChatView | null>;
  getMembership(chatId: string, userId: string): Promise<ChatMembership>;
  listForUser(
    userId: string,
    limit: number,
    after?: ChatListPosition,
  ): Promise<{ chats: ChatView[]; hasMore: boolean }>;
  renameGroup(chatId: string, name: string): Promise<void>;
  /** Adds members under a per-chat lock; existing members are ignored. */
  addMembers(
    chatId: string,
    userIds: readonly string[],
    maxMembers: number,
  ): Promise<'ADDED' | 'LIMIT_EXCEEDED'>;
  /**
   * Removes a member under a per-chat lock. A departing owner hands ownership to the
   * earliest-joined member (ties broken by user id, e.g. members added together);
   * when the last member leaves, the chat is deleted.
   */
  removeMember(chatId: string, userId: string): Promise<'REMOVED' | 'NOT_MEMBER' | 'CHAT_DELETED'>;
  /** Moves chat activity forward only; never rewinds it. */
  recordMessageActivity(chatId: string, messageId: string, at: Date): Promise<void>;
}

export interface ChatDto {
  chatId: string;
  type: ChatType;
  name: string | null;
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
    name: chat.name,
    memberIds: chat.members.map((member) => member.userId),
    members: chat.members,
    lastMessageId: chat.lastMessageId,
    lastMessageAt: chat.lastMessageAt,
    lastActivityAt: chat.lastActivityAt,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}
