import { Router, type RequestHandler } from 'express';
import type { UserController } from './user.controller.js';

export function createUserRouter(controller: UserController, authenticate: RequestHandler): Router {
  const router = Router();
  router.get('/users/me', authenticate, controller.me);
  // `/user/:userId/chats` is the assignment's contract; `/users/...` is the REST-plural alias.
  router.get('/user/:userId/chats', authenticate, controller.listChats);
  router.get('/users/:userId/chats', authenticate, controller.listChats);
  return router;
}
