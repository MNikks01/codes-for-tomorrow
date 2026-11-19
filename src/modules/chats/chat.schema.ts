import { z } from 'zod';
import { uuidSchema } from '../../shared/validation/common.schema.js';
import { MAX_GROUP_MEMBERS } from './chat.types.js';

export const createChatBodySchema = z.strictObject({
  userAId: uuidSchema,
  userBId: uuidSchema,
});

export const chatParamsSchema = z.strictObject({ chatId: uuidSchema });

export const memberParamsSchema = z.strictObject({ chatId: uuidSchema, userId: uuidSchema });

const groupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters');

const userIdListSchema = z.array(uuidSchema).min(1).max(MAX_GROUP_MEMBERS);

export const createGroupBodySchema = z.strictObject({
  name: groupNameSchema,
  memberIds: userIdListSchema,
});

export const renameGroupBodySchema = z.strictObject({ name: groupNameSchema });

export const addMembersBodySchema = z.strictObject({ userIds: userIdListSchema });
