import { z } from 'zod';

export const uuidSchema = z.uuid({ message: 'must be a valid UUID' });

/** Firestore document IDs we generate: auto-IDs (20 chars) or base64url SHA-256 (43 chars). */
export const messageIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, { message: 'must be a valid message ID' });

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export const pageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(512).optional(),
});
