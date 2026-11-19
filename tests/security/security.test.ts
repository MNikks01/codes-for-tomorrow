import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import jwt from 'jsonwebtoken';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { REDACTED_PATHS } from '../../src/config/logger.js';
import type { MessageStore } from '../../src/modules/messages/message.types.js';
import {
  createChat,
  createTestApp,
  registerUser,
  sendMessage,
  type TestApp,
  type TestUser,
} from '../helpers/test-app.js';

let ctx: TestApp;
let alice: TestUser;
let bob: TestUser;
let mallory: TestUser;
let chatId: string;
let messageId: string;

beforeAll(async () => {
  ctx = createTestApp();
  [alice, bob, mallory] = await Promise.all([
    registerUser(ctx.app, 'Alice'),
    registerUser(ctx.app, 'Bob'),
    registerUser(ctx.app, 'Mallory'),
  ]);
  chatId = await createChat(ctx.app, alice, bob);
  messageId = (await sendMessage(ctx.app, alice, chatId, 'secret plans')).id;
});

afterAll(async () => {
  await ctx.close();
});

describe('impersonation', () => {
  it('rejects a senderId that is not the authenticated user', async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/message/send`)
      .set(bob.auth)
      .send({ senderId: alice.id, text: 'I am Alice' });
    expect(res.status).toBe(403);
  });

  it('rejects read receipts and last-seen updates on behalf of others', async () => {
    const read = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/message/${messageId}/read`)
      .set(bob.auth)
      .send({ userId: alice.id });
    expect(read.status).toBe(403);
    const seen = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/lastseen`)
      .set(bob.auth)
      .send({ userId: alice.id, messageId });
    expect(seen.status).toBe(403);
  });

  it('rejects creating chats between two other users', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/chat/create')
      .set(mallory.auth)
      .send({ userAId: alice.id, userBId: bob.id });
    expect(res.status).toBe(403);
  });
});

describe('insecure direct object references', () => {
  it('blocks non-members from every chat-scoped endpoint', async () => {
    const attempts = [
      request(ctx.app).get(`/api/v1/chat/${chatId}/messages`).set(mallory.auth),
      request(ctx.app)
        .post(`/api/v1/chat/${chatId}/message/send`)
        .set(mallory.auth)
        .send({ text: 'let me in' }),
      request(ctx.app)
        .post(`/api/v1/chat/${chatId}/message/${messageId}/read`)
        .set(mallory.auth)
        .send({}),
      request(ctx.app)
        .post(`/api/v1/chat/${chatId}/lastseen`)
        .set(mallory.auth)
        .send({ messageId }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('secret plans');
    }
  });

  it("blocks listing another user's chats", async () => {
    const res = await request(ctx.app).get(`/api/v1/user/${alice.id}/chats`).set(mallory.auth);
    expect(res.status).toBe(403);
  });
});

describe('JWT validation', () => {
  const chatsUrl = () => `/api/v1/user/${alice.id}/chats`;
  const claims = () => ({
    issuer: ctx.env.JWT_ISSUER,
    audience: ctx.env.JWT_AUDIENCE,
    subject: alice.id,
  });

  it.each([
    ['missing header', undefined],
    ['non-bearer scheme', `Basic ${Buffer.from('a:b').toString('base64')}`],
    ['garbage token', 'Bearer abc.def.ghi'],
  ])('rejects %s', async (_label, header) => {
    const req = request(ctx.app).get(chatsUrl());
    const res = await (header ? req.set('Authorization', header) : req);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects expired tokens with TOKEN_EXPIRED', async () => {
    const token = jwt.sign({}, ctx.env.JWT_ACCESS_SECRET, { ...claims(), expiresIn: -60 });
    const res = await request(ctx.app).get(chatsUrl()).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects tokens signed with another key or with alg none', async () => {
    const forged = jwt.sign({}, 'attacker-controlled-secret-0123456789abcdef', claims());
    const none = jwt.sign({}, '', { ...claims(), algorithm: 'none' });
    for (const token of [forged, none]) {
      const res = await request(ctx.app).get(chatsUrl()).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = alice.accessToken.split('.');
    const payload = Buffer.from(
      JSON.stringify({
        sub: mallory.id,
        iss: ctx.env.JWT_ISSUER,
        aud: ctx.env.JWT_AUDIENCE,
        exp: 9_999_999_999,
      }),
    ).toString('base64url');
    const res = await request(ctx.app)
      .get(`/api/v1/user/${mallory.id}/chats`)
      .set('Authorization', `Bearer ${header}.${payload}.${signature}`);
    expect(res.status).toBe(401);
  });
});

describe('sensitive data exposure', () => {
  it('never returns password hashes', async () => {
    const login = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: alice.email, password: alice.password });
    const me = await request(ctx.app).get('/api/v1/users/me').set(alice.auth);
    for (const body of [login.body, me.body]) {
      expect(JSON.stringify(body)).not.toMatch(/passwordHash|argon2/i);
    }
  });

  it('hides internal error details behind a generic 500', async () => {
    const boom = () => Promise.reject(new Error('SELECT * FROM secrets -- internal detail'));
    const failingStore: MessageStore = {
      create: boom,
      findById: boom,
      listBefore: boom,
      edit: boom,
      softDelete: boom,
    };
    const failing = createTestApp({ overrides: { messageStore: failingStore } });
    const [a, b] = await Promise.all([registerUser(failing.app), registerUser(failing.app)]);
    const chat = await createChat(failing.app, a, b);
    const res = await request(failing.app).get(`/api/v1/chat/${chat}/messages`).set(a.auth);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: [] },
    });
    await failing.close();
  });

  it('sets hardened HTTP headers', async () => {
    const res = await request(ctx.app).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('only allows configured CORS origins', async () => {
    const cors = createTestApp({ appOptions: { corsOrigins: ['https://app.example'] } });
    const preflight = (origin: string) =>
      request(cors.app)
        .options('/api/v1/users/me')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'GET');
    const allowed = await preflight('https://app.example');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example');
    const blocked = await preflight('https://evil.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
    await cors.close();
  });

  it('redacts credentials from logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino(
      { level: 'trace', redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } },
      sink,
    );
    const logged = createTestApp({ logger });
    const user = await registerUser(logged.app);
    await request(logged.app).get('/api/v1/users/me').set(user.auth);
    logger.info({ body: { password: user.password, refreshToken: user.refreshToken } }, 'probe');
    const output = lines.join('\n');
    expect(output).not.toContain(user.password);
    expect(output).not.toContain(user.accessToken);
    expect(output).not.toContain(user.refreshToken);
    await logged.close();
  });
});

describe('input hardening', () => {
  it('treats prototype-pollution payloads as unknown fields', async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/message/send`)
      .set(alice.auth)
      .set('Content-Type', 'application/json')
      .send('{"text":"hi","__proto__":{"isAdmin":true}}');
    expect(res.status).toBe(400);
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  it('stores HTML as inert text and returns it as JSON, never rendering it', async () => {
    const payload = '<script>alert(1)</script>';
    const res = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/message/send`)
      .set(alice.auth)
      .send({ text: payload });
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.data.text).toBe(payload);
  });

  it('rejects path traversal style identifiers', async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/message/..%2F..%2Fusers/read`)
      .set(alice.auth)
      .send({});
    expect([400, 404]).toContain(res.status);
  });
});

describe('rate limiting', () => {
  it('throttles repeated login attempts (brute-force protection)', async () => {
    const limited = createTestApp({
      appOptions: { authRateLimit: { windowMs: 60_000, limit: 3 } },
    });
    const attempt = () =>
      request(limited.app)
        .post('/api/v1/auth/login')
        .send({ email: `${randomUUID()}@example.com`, password: 'guess-guess-guess' });
    const statuses = [];
    for (let index = 0; index < 5; index += 1) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    const last = await attempt();
    expect(last.body.error.code).toBe('RATE_LIMITED');
    expect(last.headers['ratelimit-policy']).toBeDefined();
    await limited.close();
  });

  it('throttles attempts against one account even from rotating IPs', async () => {
    const limited = createTestApp({
      appOptions: { trustProxy: true, authRateLimit: { windowMs: 60_000, limit: 3 } },
    });
    const email = `${randomUUID()}@example.com`;
    const statuses = [];
    for (let index = 0; index < 4; index += 1) {
      const res = await request(limited.app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', `203.0.113.${index + 1}`)
        .send({ email, password: 'guess-guess-guess' });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
    await limited.close();
  });
});
