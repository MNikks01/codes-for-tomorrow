import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// URL'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  FIREBASE_PROJECT_ID: z.string().min(1),
  /** When set, firebase-admin talks to the emulator and needs no credentials. */
  FIRESTORE_EMULATOR_HOST: z.string().min(1).optional(),
  /** Base64-encoded service-account JSON. Omit to use Application Default Credentials. */
  FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().min(1).optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  JWT_ISSUER: z.string().min(1).default('nodejs-chat-backend'),
  JWT_AUDIENCE: z.string().min(1).default('nodejs-chat-backend-api'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  TRUST_PROXY: booleanFlag,
  ENABLE_API_DOCS: booleanFlag,

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(15 * 60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates configuration once at startup and fails fast.
 * Error output lists variable names and reasons only, never the values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
