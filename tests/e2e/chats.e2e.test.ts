import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createChat,
  createTestApp,
  registerUser,
  sendMessage,
  type TestApp,
} from '../helpers/test-app.js';

let ctx: TestApp;

beforeAll(() => {
  ctx = createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

describe('POST /chat/create', () => {
  it('creates a chat (201) and returns the same chat afterwards (200)', async () => {
    const [alice, bob] = await Promise.all([registerUser(ctx.app), registerUser(ctx.app)]);
    const first = await request(ctx.app)
      .post('/api/v1/chat/create')
      .set(alice.auth)
      .send({ userAId: alice.id, userBId: bob.id });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ created: true, chatId: expect.any(String) });
    expect((first.body.data.chat.memberIds as string[]).sort()).toEqual([alice.id, bob.id].sort());

    const again = await request(ctx.app)
      .post('/chat/create') // unversioned alias from the assignment contract
      .set(bob.auth)
      .send({ userAId: bob.id, userBId: alice.id });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ created: false, chatId: first.body.data.chatId });
  });

  it('never creates duplicates under concurrent requests', async () => {
    const [alice, bob] = await Promise.all([registerUser(ctx.app), registerUser(ctx.app)]);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(ctx.app)
          .post('/api/v1/chat/create')
          .set(alice.auth)
          .send({ userAId: alice.id, userBId: bob.id }),
      ),
    );
    expect(
      new Set(responses.map((res) => (res.body as { data: { chatId: string } }).data.chatId)).size,
    ).toBe(1);
    expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
    expect(responses.filter((res) => res.status === 200)).toHaveLength(11);
  });

  it('rejects self-chats (422), unknown users (404) and invalid ids (400)', async () => {
    const alice = await registerUser(ctx.app);
    const self = await request(ctx.app)
      .post('/api/v1/chat/create')
      .set(alice.auth)
      .send({ userAId: alice.id, userBId: alice.id });
    expect(self.status).toBe(422);

    const unknown = await request(ctx.app)
      .post('/api/v1/chat/create')
      .set(alice.auth)
      .send({ userAId: alice.id, userBId: randomUUID() });
    expect(unknown.status).toBe(404);

    const invalid = await request(ctx.app)
      .post('/api/v1/chat/create')
      .set(alice.auth)
      .send({ userAId: alice.id, userBId: 'not-a-uuid' });
    expect(invalid.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/chat/create')
      .send({ userAId: randomUUID(), userBId: randomUUID() });
    expect(res.status).toBe(401);
  });
});

describe('GET /user/:userId/chats', () => {
  it('lists chats with members, most recently active first, with pagination', async () => {
    const owner = await registerUser(ctx.app);
    const partners = await Promise.all([
      registerUser(ctx.app),
      registerUser(ctx.app),
      registerUser(ctx.app),
    ]);
    const chatIds: string[] = [];
    for (const partner of partners) chatIds.push(await createChat(ctx.app, owner, partner));
    // The first chat becomes the most recently active one.
    await sendMessage(ctx.app, owner, chatIds[0] ?? '', 'bump');

    const page1 = await request(ctx.app).get(`/user/${owner.id}/chats?limit=2`).set(owner.auth);
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.data[0].chatId).toBe(chatIds[0]);
    expect(page1.body.data[0].lastMessageId).toEqual(expect.any(String));
    expect(page1.body.data[0].members).toHaveLength(2);
    expect(page1.body.meta.nextCursor).toEqual(expect.any(String));

    const page2 = await request(ctx.app)
      .get(`/api/v1/users/${owner.id}/chats`)
      .query({ limit: 2, cursor: page1.body.meta.nextCursor })
      .set(owner.auth);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta.nextCursor).toBeNull();

    const all = [...page1.body.data, ...page2.body.data].map(
      (chat: { chatId: string }) => chat.chatId,
    );
    expect(new Set(all)).toEqual(new Set(chatIds));
  });

  it('validates pagination parameters', async () => {
    const owner = await registerUser(ctx.app);
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'cursor=@@@']) {
      const res = await request(ctx.app)
        .get(`/api/v1/user/${owner.id}/chats?${query}`)
        .set(owner.auth);
      expect(res.status, query).toBe(400);
    }
  });
});
