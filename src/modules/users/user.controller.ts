import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/authenticate.js';
import { sendSuccess } from '../../shared/http/response.js';
import { pageQuerySchema } from '../../shared/validation/common.schema.js';
import { parseInput } from '../../shared/validation/parse.js';
import type { ChatService } from '../chats/chat.service.js';
import { toChatDto } from '../chats/chat.types.js';
import { userParamsSchema } from './user.schema.js';
import type { UserService } from './user.service.js';

export class UserController {
  constructor(
    private readonly users: UserService,
    private readonly chats: ChatService,
  ) {}

  me = async (req: Request, res: Response): Promise<void> => {
    const { userId } = requireAuth(req);
    sendSuccess(res, await this.users.getProfile(userId));
  };

  listChats = async (req: Request, res: Response): Promise<void> => {
    const actor = requireAuth(req);
    const { userId } = parseInput(userParamsSchema, req.params, 'params');
    const page = parseInput(pageQuerySchema, req.query, 'query');
    const result = await this.chats.listUserChats(actor.userId, userId, page);
    sendSuccess(res, result.chats.map(toChatDto), {
      meta: { limit: page.limit, nextCursor: result.nextCursor },
    });
  };
}
