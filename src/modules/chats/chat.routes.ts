import { Router, type RequestHandler } from 'express';
import type { ChatController } from './chat.controller.js';

export function createChatRouter(controller: ChatController, authenticate: RequestHandler): Router {
  const router = Router();
  router.post('/chat/create', authenticate, controller.createOrGet);
  router.post('/chat/group/create', authenticate, controller.createGroup);
  router.patch('/chat/:chatId', authenticate, controller.rename);
  router.post('/chat/:chatId/members', authenticate, controller.addMembers);
  router.delete('/chat/:chatId/members/:userId', authenticate, controller.removeMember);
  return router;
}
