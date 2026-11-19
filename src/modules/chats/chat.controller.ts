import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/authenticate.js';
import { sendSuccess } from '../../shared/http/response.js';
import { parseInput } from '../../shared/validation/parse.js';
import {
  addMembersBodySchema,
  chatParamsSchema,
  createChatBodySchema,
  createGroupBodySchema,
  memberParamsSchema,
  renameGroupBodySchema,
} from './chat.schema.js';
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

  createGroup = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const body = parseInput(createGroupBodySchema, req.body, 'body');
    const chat = await this.chats.createGroup(actor.userId, body);
    sendSuccess(res, { chatId: chat.id, chat: toChatDto(chat) }, { status: 201 });
  };

  rename = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const { chatId } = parseInput(chatParamsSchema, req.params, 'params');
    const { name } = parseInput(renameGroupBodySchema, req.body, 'body');
    sendSuccess(res, toChatDto(await this.chats.renameGroup(actor.userId, chatId, name)));
  };

  addMembers = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const { chatId } = parseInput(chatParamsSchema, req.params, 'params');
    const { userIds } = parseInput(addMembersBodySchema, req.body, 'body');
    sendSuccess(res, toChatDto(await this.chats.addMembers(actor.userId, chatId, userIds)));
  };

  /** Removing yourself means leaving the group. */
  removeMember = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const { chatId, userId } = parseInput(memberParamsSchema, req.params, 'params');
    await this.chats.removeMember(actor.userId, chatId, userId);
    res.status(204).end();
  };
}
