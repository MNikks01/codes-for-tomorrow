/**
 * Exact position of a message in a chat's total order: server timestamp with
 * nanosecond precision, tie-broken by document ID. Used for pagination cursors
 * and for the "last seen never moves backwards" rule.
 */
export interface MessagePosition {
  seconds: number;
  nanos: number;
  id: string;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  position: MessagePosition;
}

export interface CreateMessageInput {
  chatId: string;
  senderId: string;
  text: string;
  idempotencyKey?: string | undefined;
}

export interface MessagePage {
  /** Newest first, exactly as read from storage. */
  messages: Message[];
  hasMore: boolean;
}

export interface MessageStore {
  create(input: CreateMessageInput): Promise<{ message: Message; created: boolean }>;
  findById(chatId: string, messageId: string): Promise<Message | null>;
  listBefore(chatId: string, limit: number, before?: MessagePosition): Promise<MessagePage>;
}

export interface ReadReceipt {
  chatId: string;
  messageId: string;
  userId: string;
  readAt: Date;
}

export interface ReceiptStore {
  markRead(
    chatId: string,
    messageId: string,
    userId: string,
  ): Promise<{ receipt: ReadReceipt; created: boolean }>;
}

export interface LastSeen {
  chatId: string;
  userId: string;
  messageId: string;
  messageCreatedAt: Date;
  lastSeenAt: Date;
}

export interface LastSeenStore {
  advance(
    chatId: string,
    userId: string,
    message: Message,
  ): Promise<{ lastSeen: LastSeen; updated: boolean }>;
}

export function comparePositions(a: MessagePosition, b: MessagePosition): number {
  if (a.seconds !== b.seconds) return a.seconds - b.seconds;
  if (a.nanos !== b.nanos) return a.nanos - b.nanos;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
