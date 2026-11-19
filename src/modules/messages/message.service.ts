import type { Logger } from 'pino';
import { z } from 'zod';
import { AuthorizationError, NotFoundError } from '../../shared/errors/app-error.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination/cursor.js';
import { messageIdSchema } from '../../shared/validation/common.schema.js';
import type { ChatService } from '../chats/chat.service.js';
import type {
  LastSeen,
  LastSeenStore,
  Message,
  MessageStore,
  ReadReceipt,
  ReceiptStore,
} from './message.types.js';

const messageCursorSchema = z.strictObject({
  // Firestore Timestamp's valid range ends at 9999-12-31T23:59:59Z.
  s: z.number().int().min(0).max(253_402_300_799),
  n: z.number().int().min(0).max(999_999_999),
  id: messageIdSchema,
});

type ChatAccess = Pick<ChatService, 'assertMember' | 'recordMessageActivity'>;

export interface MessagePageResult {
  /** Chronological (oldest first) within the page. */
  messages: Message[];
  /** Fetches the page of older messages; null when the beginning of the chat is reached. */
  nextCursor: string | null;
}

export class MessageService {
  constructor(
    private readonly chats: ChatAccess,
    private readonly messages: MessageStore,
    private readonly receipts: ReceiptStore,
    private readonly lastSeen: LastSeenStore,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {}

  async send(
    actorId: string,
    chatId: string,
    input: { senderId?: string | undefined; text: string; idempotencyKey?: string | undefined },
  ): Promise<{ message: Message; created: boolean }> {
    assertSelf(actorId, input.senderId);
    await this.chats.assertMember(chatId, actorId);

    const result = await this.messages.create({
      chatId,
      senderId: actorId,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    });
    // Runs on replays too, so a retried request repairs a previously failed sync.
    await this.syncChatActivity(result.message);
    return result;
  }

  async list(
    actorId: string,
    chatId: string,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<MessagePageResult> {
    await this.chats.assertMember(chatId, actorId);
    const cursor = page.cursor ? decodeCursor(page.cursor, messageCursorSchema) : undefined;
    const result = await this.messages.listBefore(
      chatId,
      page.limit,
      cursor ? { seconds: cursor.s, nanos: cursor.n, id: cursor.id } : undefined,
    );
    const oldest = result.messages.at(-1);
    return {
      messages: [...result.messages].reverse(),
      nextCursor:
        result.hasMore && oldest
          ? encodeCursor({ s: oldest.position.seconds, n: oldest.position.nanos, id: oldest.id })
          : null,
    };
  }

  async markRead(
    actorId: string,
    chatId: string,
    messageId: string,
    claimedUserId?: string,
  ): Promise<{ receipt: ReadReceipt; created: boolean }> {
    assertSelf(actorId, claimedUserId);
    await this.chats.assertMember(chatId, actorId);
    await this.requireMessage(chatId, messageId);
    return this.receipts.markRead(chatId, messageId, actorId);
  }

  async updateLastSeen(
    actorId: string,
    chatId: string,
    input: { messageId: string; userId?: string | undefined },
  ): Promise<{ lastSeen: LastSeen; updated: boolean }> {
    assertSelf(actorId, input.userId);
    await this.chats.assertMember(chatId, actorId);
    const message = await this.requireMessage(chatId, input.messageId);
    return this.lastSeen.advance(chatId, actorId, message);
  }

  /** Messages live under their chat's path, so a lookup scoped to chatId proves ownership. */
  private async requireMessage(chatId: string, messageId: string): Promise<Message> {
    const message = await this.messages.findById(chatId, messageId);
    if (!message) throw new NotFoundError('Message');
    return message;
  }

  /**
   * Firestore (message) and PostgreSQL (chat activity) cannot share a transaction.
   * The message is the durable fact; chat ordering metadata is derived and best-effort.
   */
  private async syncChatActivity(message: Message): Promise<void> {
    const sync = () =>
      this.chats.recordMessageActivity(message.chatId, message.id, message.createdAt);
    try {
      // One immediate retry absorbs transient blips (e.g. a recycled pool connection).
      await sync().catch(sync);
    } catch (err) {
      this.logger.warn(
        { err, chatId: message.chatId, messageId: message.id, event: 'chat_activity_sync_failed' },
        'Message stored but chat activity metadata was not updated',
      );
    }
  }
}

function assertSelf(actorId: string, claimedUserId: string | undefined): void {
  if (claimedUserId !== undefined && claimedUserId !== actorId) {
    throw new AuthorizationError('You cannot act on behalf of another user');
  }
}
