import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { pino, type Logger } from 'pino';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { toAppOptions, type AppOptions } from '../../src/config/app.config.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { buildContainer, type Container, type ContainerOverrides } from '../../src/container.js';
import { Argon2PasswordHasher } from '../../src/infrastructure/security/password-hasher.js';

/** Cheap Argon2id parameters: same algorithm and code path, fast enough for tests. */
export const fastHasher = new Argon2PasswordHasher({
  memoryCost: 1024,
  timeCost: 1,
  parallelism: 1,
});

export interface TestApp {
  app: Express;
  container: Container;
  env: Env;
  close(): Promise<void>;
}

export function createTestApp(
  options: {
    env?: Partial<Record<string, string>>;
    overrides?: ContainerOverrides;
    appOptions?: Partial<AppOptions>;
    logger?: Logger;
  } = {},
): TestApp {
  const env = loadEnv({ ...process.env, ...options.env });
  const logger = options.logger ?? pino({ level: 'silent' });
  const container = buildContainer(env, logger, {
    passwordHasher: fastHasher,
    ...options.overrides,
  });
  const appOptions: AppOptions = {
    ...toAppOptions(env, 'test'),
    apiRateLimit: { windowMs: 60_000, limit: 100_000 },
    authRateLimit: { windowMs: 60_000, limit: 100_000 },
    ...options.appOptions,
  };
  return {
    app: createApp(container.services, appOptions, logger),
    container,
    env,
    close: () => container.close(),
  };
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  auth: { Authorization: string };
}

export async function registerUser(app: Express, name = 'Test User'): Promise<TestUser> {
  const email = `user-${randomUUID()}@example.com`;
  const password = 'correct-horse-battery-staple';
  const res = await request(app).post('/api/v1/auth/register').send({ name, email, password });
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as {
    data: { user: { id: string }; tokens: { accessToken: string; refreshToken: string } };
  };
  return {
    id: body.data.user.id,
    email,
    password,
    accessToken: body.data.tokens.accessToken,
    refreshToken: body.data.tokens.refreshToken,
    auth: { Authorization: `Bearer ${body.data.tokens.accessToken}` },
  };
}

export async function createChat(app: Express, a: TestUser, b: TestUser): Promise<string> {
  const res = await request(app)
    .post('/api/v1/chat/create')
    .set(a.auth)
    .send({ userAId: a.id, userBId: b.id });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`chat create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return (res.body as { data: { chatId: string } }).data.chatId;
}

export async function sendMessage(
  app: Express,
  user: TestUser,
  chatId: string,
  text: string,
): Promise<{ id: string; createdAt: string }> {
  const res = await request(app)
    .post(`/api/v1/chat/${chatId}/message/send`)
    .set(user.auth)
    .send({ text });
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { data: { id: string; createdAt: string } }).data;
}
