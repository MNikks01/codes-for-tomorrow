import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { withFirestore } from '../../src/infrastructure/firestore/firestore-errors.js';
import type { MessageStore } from '../../src/modules/messages/message.types.js';
import { createChat, createTestApp, registerUser, type TestApp } from '../helpers/test-app.js';

/** Simulates Firestore's gRPC UNAVAILABLE at the store boundary (same mapping path as production). */
const unavailable = () =>
  withFirestore(() =>
    Promise.reject(Object.assign(new Error('14 UNAVAILABLE: no connection'), { code: 14 })),
  );

const unavailableStore: MessageStore = {
  create: unavailable,
  findById: unavailable,
  listBefore: unavailable,
  edit: unavailable,
  softDelete: unavailable,
};

describe('health endpoints', () => {
  let ctx: TestApp;
  beforeAll(() => {
    ctx = createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('reports liveness and readiness of PostgreSQL and Firestore', async () => {
    expect((await request(ctx.app).get('/health/live')).body).toEqual({ status: 'ok' });
    const ready = await request(ctx.app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.dependencies).toEqual({ postgres: 'up', firestore: 'up' });
    const summary = await request(ctx.app).get('/health');
    expect(summary.body).toMatchObject({ status: 'ok', version: 'test' });
  });

  it('serves the OpenAPI document when docs are enabled', async () => {
    const docs = createTestApp({ appOptions: { enableApiDocs: true } });
    const res = await request(docs.app).get('/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    await docs.close();
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(ctx.app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('when PostgreSQL is unavailable', () => {
  let ctx: TestApp;
  beforeAll(() => {
    // Port 1 is never a PostgreSQL server: connections are refused immediately.
    ctx = createTestApp({ env: { DATABASE_URL: 'postgresql://chat:chat@127.0.0.1:1/chat' } });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('returns 503 DATABASE_UNAVAILABLE without leaking driver details', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'someone@example.com', password: 'irrelevant-password' });
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'DATABASE_UNAVAILABLE',
      message: 'Database is temporarily unavailable',
      details: [],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|prisma/i);
  });

  it('reports not-ready', async () => {
    const res = await request(ctx.app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.dependencies.postgres).toBe('down');
  });
});

describe('when Firestore is unavailable', () => {
  let ctx: TestApp;
  beforeAll(() => {
    ctx = createTestApp({ overrides: { messageStore: unavailableStore } });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('returns 503 DEPENDENCY_UNAVAILABLE for sends and reads', async () => {
    const [alice, bob] = await Promise.all([registerUser(ctx.app), registerUser(ctx.app)]);
    const chatId = await createChat(ctx.app, alice, bob);

    const send = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/message/send`)
      .set(alice.auth)
      .send({ text: 'hello' });
    expect(send.status).toBe(503);
    expect(send.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(JSON.stringify(send.body)).not.toContain('UNAVAILABLE: no connection');

    const list = await request(ctx.app).get(`/api/v1/chat/${chatId}/messages`).set(alice.auth);
    expect(list.status).toBe(503);

    // Membership is still enforced before Firestore is touched.
    const outsider = await registerUser(ctx.app);
    const denied = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/message/${randomUUID().slice(0, 20)}/read`)
      .set(outsider.auth)
      .send({});
    expect(denied.status).toBe(403);
  });
});
