import { Router, type RequestHandler } from 'express';
import type { MessageController } from './message.controller.js';

export function createMessageRouter(
  controller: MessageController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.post('/chat/:chatId/message/send', authenticate, controller.send);
  router.get('/chat/:chatId/messages', authenticate, controller.list);
  router.post('/chat/:chatId/message/:messageId/read', authenticate, controller.markRead);
  router.post('/chat/:chatId/lastseen', authenticate, controller.updateLastSeen);
  router.patch('/chat/:chatId/message/:messageId', authenticate, controller.edit);
  router.delete('/chat/:chatId/message/:messageId', authenticate, controller.delete);
  return router;
}
