import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/authenticate.js';
import { sendSuccess } from '../../shared/http/response.js';
import { parseInput } from '../../shared/validation/parse.js';
import { createChatBodySchema } from './chat.schema.js';
import type { ChatService } from './chat.service.js';
import { toChatDto } from './chat.types.js';

export class ChatController {
  constructor(private readonly chats: ChatService) {}

  /** 201 when a new chat was created, 200 when the existing one is returned. */
  createOrGet = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const body = parseInput(createChatBodySchema, req.body, 'body');
    const { chat, created } = await this.chats.createOrGetDirect(actor.userId, body);
    sendSuccess(
      res,
      { chatId: chat.id, created, chat: toChatDto(chat) },
      { status: created ? 201 : 200 },
    );
  };
}
