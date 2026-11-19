import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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
let chatId: string;

beforeAll(() => {
  ctx = createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  [alice, bob] = await Promise.all([registerUser(ctx.app), registerUser(ctx.app)]);
  chatId = await createChat(ctx.app, alice, bob);
});

const sendUrl = () => `/api/v1/chat/${chatId}/message/send`;

describe('POST /chat/:chatId/message/send', () => {
  it('stores a message with server timestamps and sender info', async () => {
    const res = await request(ctx.app)
      .post(sendUrl())
      .set(alice.auth)
      .send({ senderId: alice.id, text: '  Hello Bob  ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      chatId,
      senderId: alice.id,
      text: 'Hello Bob',
      editedAt: null,
    });
    expect(Date.parse(res.body.data.createdAt as string)).not.toBeNaN();
  });

  it('ignores client-supplied timestamps by rejecting unknown fields', async () => {
    const res = await request(ctx.app)
      .post(sendUrl())
      .set(alice.auth)
      .send({ text: 'hi', createdAt: '1999-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
  });

  it('replays duplicate retries with the same Idempotency-Key instead of duplicating', async () => {
    const send = () =>
      request(ctx.app)
        .post(sendUrl())
        .set(alice.auth)
        .set('Idempotency-Key', 'client-retry-0001')
        .send({ text: 'only once' });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);

    const list = await request(ctx.app).get(`/api/v1/chat/${chatId}/messages`).set(bob.auth);
    expect(list.body.data).toHaveLength(1);
  });

  it('409s when an Idempotency-Key is reused for different content', async () => {
    const send = (text: string) =>
      request(ctx.app)
        .post(sendUrl())
        .set(alice.auth)
        .set('Idempotency-Key', 'client-retry-0002')
        .send({ text });
    expect((await send('one')).status).toBe(201);
    expect((await send('two')).status).toBe(409);
  });

  it.each([
    ['empty text', { text: '' }, 400],
    ['whitespace text', { text: '    ' }, 400],
    ['oversized text', { text: 'x'.repeat(4001) }, 400],
    ['missing text', {}, 400],
  ])('rejects %s', async (_label, body, status) => {
    const res = await request(ctx.app).post(sendUrl()).set(alice.auth).send(body);
    expect(res.status).toBe(status);
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const malformed = await request(ctx.app)
      .post(sendUrl())
      .set(alice.auth)
      .set('Content-Type', 'application/json')
      .send('{"text": ');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('MALFORMED_REQUEST');

    const huge = await request(ctx.app)
      .post(sendUrl())
      .set(alice.auth)
      .send({ text: 'x'.repeat(40_000) });
    expect(huge.status).toBe(413);
  });

  it('404s for unknown chats and 400s for invalid chat ids', async () => {
    const missing = await request(ctx.app)
      .post(`/api/v1/chat/${randomUUID()}/message/send`)
      .set(alice.auth)
      .send({ text: 'hi' });
    expect(missing.status).toBe(404);
    const invalid = await request(ctx.app)
      .post('/api/v1/chat/abc/message/send')
      .set(alice.auth)
      .send({ text: 'hi' });
    expect(invalid.status).toBe(400);
  });
});

describe('GET /chat/:chatId/messages', () => {
  it('returns chronological pages, newest page first, without gaps or duplicates', async () => {
    const texts = Array.from({ length: 7 }, (_, index) => `message ${index}`);
    for (const [index, text] of texts.entries()) {
      await sendMessage(ctx.app, index % 2 === 0 ? alice : bob, chatId, text);
    }

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const res = await request(ctx.app)
        .get(`/chat/${chatId}/messages`)
        .query({ limit: 3, ...(cursor ? { cursor } : {}) })
        .set(bob.auth);
      expect(res.status).toBe(200);
      pages.push((res.body.data as { text: string }[]).map((message) => message.text));
      cursor = res.body.meta.nextCursor as string | null;
    } while (cursor);

    expect(pages[0]).toEqual(['message 4', 'message 5', 'message 6']);
    expect(pages.reverse().flat()).toEqual(texts);
  });

  it('defaults to 50 and caps the page size at 100', async () => {
    const ok = await request(ctx.app).get(`/api/v1/chat/${chatId}/messages`).set(alice.auth);
    expect(ok.body.meta.limit).toBe(50);
    const tooBig = await request(ctx.app)
      .get(`/api/v1/chat/${chatId}/messages?limit=500`)
      .set(alice.auth);
    expect(tooBig.status).toBe(400);
    const badCursor = await request(ctx.app)
      .get(`/api/v1/chat/${chatId}/messages?cursor=eyJ4IjoxfQ`)
      .set(alice.auth);
    expect(badCursor.status).toBe(400);
  });
});

describe('POST /chat/:chatId/message/:messageId/read', () => {
  it('creates a receipt once and returns the original on repeats', async () => {
    const message = await sendMessage(ctx.app, alice, chatId, 'please read');
    const url = `/api/v1/chat/${chatId}/message/${message.id}/read`;
    const first = await request(ctx.app).post(url).set(bob.auth).send({ userId: bob.id });
    const second = await request(ctx.app).post(url).set(bob.auth).send({});
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ created: false, userId: bob.id });
    expect(second.body.data.readAt).toBe(first.body.data.readAt);
  });

  it('404s for messages that do not exist in this chat', async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/message/doesNotExist123/read`)
      .set(bob.auth)
      .send({});
    expect(res.status).toBe(404);

    // A real message from another chat must not be addressable through this chat.
    const carol = await registerUser(ctx.app);
    const otherChat = await createChat(ctx.app, alice, carol);
    const foreign = await sendMessage(ctx.app, alice, otherChat, 'elsewhere');
    const crossChat = await request(ctx.app)
      .post(`/api/v1/chat/${chatId}/message/${foreign.id}/read`)
      .set(bob.auth)
      .send({});
    expect(crossChat.status).toBe(404);
  });
});

describe('POST /chat/:chatId/lastseen', () => {
  it('advances the pointer and refuses to move it backwards', async () => {
    const older = await sendMessage(ctx.app, alice, chatId, 'older');
    const newer = await sendMessage(ctx.app, alice, chatId, 'newer');
    const url = `/api/v1/chat/${chatId}/lastseen`;

    const forward = await request(ctx.app)
      .post(url)
      .set(bob.auth)
      .send({ userId: bob.id, messageId: newer.id });
    expect(forward.status).toBe(200);
    expect(forward.body.data).toMatchObject({ messageId: newer.id, updated: true });

    const backward = await request(ctx.app).post(url).set(bob.auth).send({ messageId: older.id });
    expect(backward.status).toBe(200);
    expect(backward.body.data).toMatchObject({ messageId: newer.id, updated: false });
  });

  it('rejects unknown or malformed message ids', async () => {
    const url = `/api/v1/chat/${chatId}/lastseen`;
    expect(
      (await request(ctx.app).post(url).set(bob.auth).send({ messageId: 'missing123' })).status,
    ).toBe(404);
    expect((await request(ctx.app).post(url).set(bob.auth).send({ messageId: 'a/b' })).status).toBe(
      400,
    );
    expect((await request(ctx.app).post(url).set(bob.auth).send({})).status).toBe(400);
  });
});
