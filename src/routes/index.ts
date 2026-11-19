import { Router, type RequestHandler } from 'express';
import type { AuthController } from '../modules/auth/auth.controller.js';
import { createAuthRouter, type AuthLimiters } from '../modules/auth/auth.routes.js';
import type { ChatController } from '../modules/chats/chat.controller.js';
import { createChatRouter } from '../modules/chats/chat.routes.js';
import type { MessageController } from '../modules/messages/message.controller.js';
import { createMessageRouter } from '../modules/messages/message.routes.js';
import type { UserController } from '../modules/users/user.controller.js';
import { createUserRouter } from '../modules/users/user.routes.js';

export interface ApiRouterDependencies {
  controllers: {
    auth: AuthController;
    users: UserController;
    chats: ChatController;
    messages: MessageController;
  };
  authenticate: RequestHandler;
  authLimiters: AuthLimiters;
}

export function createApiRouter(deps: ApiRouterDependencies): Router {
  const router = Router();
  router.use(createAuthRouter(deps.controllers.auth, deps.authLimiters));
  router.use(createUserRouter(deps.controllers.users, deps.authenticate));
  router.use(createChatRouter(deps.controllers.chats, deps.authenticate));
  router.use(createMessageRouter(deps.controllers.messages, deps.authenticate));
  return router;
}
