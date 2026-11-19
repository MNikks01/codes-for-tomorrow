import { z } from 'zod';

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const registerBodySchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters'),
  email: emailSchema,
  // Upper bound keeps hashing cost bounded (Argon2 work grows with input length).
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export const loginBodySchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const refreshBodySchema = z.strictObject({
  refreshToken: z.string().min(20).max(200),
});
