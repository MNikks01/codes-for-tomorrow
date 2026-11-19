import { z } from 'zod';
import { uuidSchema } from '../../shared/validation/common.schema.js';

export const createChatBodySchema = z.strictObject({
  userAId: uuidSchema,
  userBId: uuidSchema,
});

export const chatParamsSchema = z.strictObject({ chatId: uuidSchema });
