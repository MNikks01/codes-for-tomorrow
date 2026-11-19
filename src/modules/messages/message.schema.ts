import { z } from 'zod';
import { messageIdSchema, uuidSchema } from '../../shared/validation/common.schema.js';

export const MESSAGE_MAX_LENGTH = 4000;

/**
 * Text is stored as plain text and never interpreted as HTML by this service;
 * clients must escape it when rendering. NFC normalisation keeps lengths and
 * equality checks (idempotent retries) consistent across platforms.
 */
const messageTextSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, 'must not be empty')
      .max(MESSAGE_MAX_LENGTH, `must be at most ${MESSAGE_MAX_LENGTH} characters`)
      .refine((value) => !value.includes('\u0000'), 'must not contain NUL characters'),
  );

export const sendMessageBodySchema = z.strictObject({
  /** Optional: identity comes from the JWT; if supplied it must match it. */
  senderId: uuidSchema.optional(),
  text: messageTextSchema,
});

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{8,128}$/, 'must be 8-128 characters of [A-Za-z0-9_.:-]')
  .optional();

export const messageParamsSchema = z.strictObject({
  chatId: uuidSchema,
  messageId: messageIdSchema,
});

export const markReadBodySchema = z.strictObject({
  userId: uuidSchema.optional(),
});

export const lastSeenBodySchema = z.strictObject({
  userId: uuidSchema.optional(),
  messageId: messageIdSchema,
});
