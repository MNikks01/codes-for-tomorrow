import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/authenticate.js';
import { sendSuccess } from '../../shared/http/response.js';
import { pageQuerySchema } from '../../shared/validation/common.schema.js';
import { parseInput } from '../../shared/validation/parse.js';
import { chatParamsSchema } from '../chats/chat.schema.js';
import {
  idempotencyKeySchema,
  lastSeenBodySchema,
  markReadBodySchema,
  messageParamsSchema,
  sendMessageBodySchema,
} from './message.schema.js';
import type { MessageService } from './message.service.js';
import type { Message } from './message.types.js';

export class MessageController {
  constructor(private readonly messages: MessageService) {}

  send = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const { chatId } = parseInput(chatParamsSchema, req.params, 'params');
    const body = parseInput(sendMessageBodySchema, req.body, 'body');
    const idempotencyKey = parseInput(idempotencyKeySchema, req.get('idempotency-key'), 'headers');
    const { message, created } = await this.messages.send(actor.userId, chatId, {
      ...body,
      idempotencyKey,
    });
    if (!created) res.setHeader('Idempotent-Replayed', 'true');
    sendSuccess(res, toMessageDto(message), { status: created ? 201 : 200 });
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const { chatId } = parseInput(chatParamsSchema, req.params, 'params');
    const page = parseInput(pageQuerySchema, req.query, 'query');
    const result = await this.messages.list(actor.userId, chatId, page);
    sendSuccess(res, result.messages.map(toMessageDto), {
      meta: { limit: page.limit, nextCursor: result.nextCursor },
    });
  };

  markRead = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const { chatId, messageId } = parseInput(messageParamsSchema, req.params, 'params');
    const body = parseInput(markReadBodySchema, req.body ?? {}, 'body');
    const { receipt, created } = await this.messages.markRead(
      actor.userId,
      chatId,
      messageId,
      body.userId,
    );
    sendSuccess(res, { ...receipt, created }, { status: created ? 201 : 200 });
  };

  updateLastSeen = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const { chatId } = parseInput(chatParamsSchema, req.params, 'params');
    const body = parseInput(lastSeenBodySchema, req.body, 'body');
    const { lastSeen, updated } = await this.messages.updateLastSeen(actor.userId, chatId, body);
    sendSuccess(res, { ...lastSeen, updated });
  };
}

function toMessageDto(message: Message): Omit<Message, 'position'> {
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    text: message.text,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    editedAt: message.editedAt,
  };
}
