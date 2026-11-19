import { Router, type RequestHandler } from 'express';
import type { ChatController } from './chat.controller.js';

export function createChatRouter(controller: ChatController, authenticate: RequestHandler): Router {
  const router = Router();
  router.post('/chat/create', authenticate, controller.createOrGet);
  return router;
}
