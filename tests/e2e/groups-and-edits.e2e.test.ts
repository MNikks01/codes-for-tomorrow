import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

beforeAll(() => {
  ctx = createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

const createGroup = async (owner: TestUser, members: TestUser[], name = 'Team') => {
  const res = await request(ctx.app)
    .post('/chat/group/create')
    .set(owner.auth)
    .send({ name, memberIds: members.map((member) => member.id) });
  expect(res.status).toBe(201);
  return res.body.data.chatId as string;
};

describe('group chats', () => {
  it('creates a group usable by every member for messaging', async () => {
    const [owner, alice, bob] = await Promise.all([
      registerUser(ctx.app),
      registerUser(ctx.app),
      registerUser(ctx.app),
    ]);
    const res = await request(ctx.app)
      .post('/api/v1/chat/group/create')
      .set(owner.auth)
      .send({ name: '  Launch crew ', memberIds: [alice.id, bob.id] });
    expect(res.status).toBe(201);
    expect(res.body.data.chat).toMatchObject({ type: 'GROUP', name: 'Launch crew' });
    expect(res.body.data.chat.members[0]).toMatchObject({ userId: owner.id, role: 'OWNER' });
    const chatId = res.body.data.chatId as string;

    await sendMessage(ctx.app, alice, chatId, 'hi all');
    const list = await request(ctx.app).get(`/chat/${chatId}/messages`).set(bob.auth);
    expect((list.body.data as { text: string }[]).map((m) => m.text)).toEqual(['hi all']);

    const chats = await request(ctx.app).get(`/user/${bob.id}/chats`).set(bob.auth);
    expect(chats.body.data[0]).toMatchObject({ chatId, name: 'Launch crew' });
  });

  it('lets the owner rename and manage members; removed members lose access', async () => {
    const [owner, alice, bob] = await Promise.all([
      registerUser(ctx.app),
      registerUser(ctx.app),
      registerUser(ctx.app),
    ]);
    const chatId = await createGroup(owner, [alice]);

    const renamed = await request(ctx.app)
      .patch(`/chat/${chatId}`)
      .set(owner.auth)
      .send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('Renamed');

    const added = await request(ctx.app)
      .post(`/chat/${chatId}/members`)
      .set(owner.auth)
      .send({ userIds: [bob.id] });
    expect(added.status).toBe(200);
    expect(added.body.data.memberIds).toContain(bob.id);

    const removed = await request(ctx.app)
      .delete(`/chat/${chatId}/members/${bob.id}`)
      .set(owner.auth);
    expect(removed.status).toBe(204);
    const denied = await request(ctx.app).get(`/chat/${chatId}/messages`).set(bob.auth);
    expect(denied.status).toBe(403);
  });

  it('forbids non-owners from managing, and rejects management of direct chats', async () => {
    const [owner, alice, bob] = await Promise.all([
      registerUser(ctx.app),
      registerUser(ctx.app),
      registerUser(ctx.app),
    ]);
    const chatId = await createGroup(owner, [alice, bob]);
    expect(
      (await request(ctx.app).patch(`/chat/${chatId}`).set(alice.auth).send({ name: 'Mine' }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app)
          .post(`/chat/${chatId}/members`)
          .set(alice.auth)
          .send({ userIds: [owner.id] })
      ).status,
    ).toBe(403);
    expect(
      (await request(ctx.app).delete(`/chat/${chatId}/members/${bob.id}`).set(alice.auth)).status,
    ).toBe(403);

    const direct = await createChat(ctx.app, owner, alice);
    expect(
      (await request(ctx.app).patch(`/chat/${direct}`).set(owner.auth).send({ name: 'Nope' }))
        .status,
    ).toBe(422);
  });

  it('transfers ownership to a remaining member when the owner leaves', async () => {
    const [owner, alice, bob] = await Promise.all([
      registerUser(ctx.app),
      registerUser(ctx.app),
      registerUser(ctx.app),
    ]);
    const chatId = await createGroup(owner, [alice, bob]);
    expect(
      (await request(ctx.app).delete(`/chat/${chatId}/members/${owner.id}`).set(owner.auth)).status,
    ).toBe(204);

    const chats = await request(ctx.app).get(`/user/${alice.id}/chats`).set(alice.auth);
    const group = (
      chats.body.data as { chatId: string; members: { userId: string; role: string }[] }[]
    ).find((chat) => chat.chatId === chatId);
    const owners = group?.members.filter((member) => member.role === 'OWNER') ?? [];
    expect(owners).toHaveLength(1);
    expect([alice.id, bob.id]).toContain(owners[0]?.userId);
    expect(group?.members.map((member) => member.userId)).not.toContain(owner.id);

    const newOwner = owners[0]?.userId === alice.id ? alice : bob;
    const renamed = await request(ctx.app)
      .patch(`/chat/${chatId}`)
      .set(newOwner.auth)
      .send({ name: 'New owner' });
    expect(renamed.status).toBe(200);
  });

  it('validates group input', async () => {
    const owner = await registerUser(ctx.app);
    for (const body of [
      { name: '', memberIds: [owner.id] },
      { name: 'X', memberIds: [] },
      { name: 'X', memberIds: ['not-a-uuid'] },
      { name: 'X', memberIds: [owner.id], extra: true },
    ]) {
      expect(
        (await request(ctx.app).post('/chat/group/create').set(owner.auth).send(body)).status,
      ).toBe(400);
    }
    expect(
      (
        await request(ctx.app)
          .post('/chat/group/create')
          .set(owner.auth)
          .send({ name: 'X', memberIds: [owner.id] })
      ).status,
    ).toBe(422);
  });
});

describe('message edit/delete', () => {
  it('lets the sender edit, then delete; readers see a tombstone', async () => {
    const [alice, bob] = await Promise.all([registerUser(ctx.app), registerUser(ctx.app)]);
    const chatId = await createChat(ctx.app, alice, bob);
    const message = await sendMessage(ctx.app, alice, chatId, 'tpyo');
    const url = `/chat/${chatId}/message/${message.id}`;

    const edited = await request(ctx.app).patch(url).set(alice.auth).send({ text: 'typo fixed' });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ text: 'typo fixed', deletedAt: null });
    expect(edited.body.data.editedAt).toEqual(expect.any(String));
    expect(edited.body.data.createdAt).toBe(message.createdAt);

    expect((await request(ctx.app).delete(url).set(alice.auth)).status).toBe(204);
    expect((await request(ctx.app).delete(url).set(alice.auth)).status).toBe(204);

    const list = await request(ctx.app).get(`/chat/${chatId}/messages`).set(bob.auth);
    expect(list.body.data[0]).toMatchObject({
      id: message.id,
      text: null,
      deletedAt: expect.any(String),
    });

    expect((await request(ctx.app).patch(url).set(alice.auth).send({ text: 'again' })).status).toBe(
      409,
    );
  });

  it('forbids editing or deleting other members’ messages and validates input', async () => {
    const [alice, bob, mallory] = await Promise.all([
      registerUser(ctx.app),
      registerUser(ctx.app),
      registerUser(ctx.app),
    ]);
    const chatId = await createChat(ctx.app, alice, bob);
    const message = await sendMessage(ctx.app, alice, chatId, 'mine');
    const url = `/chat/${chatId}/message/${message.id}`;

    expect((await request(ctx.app).patch(url).set(bob.auth).send({ text: 'yours?' })).status).toBe(
      403,
    );
    expect((await request(ctx.app).delete(url).set(bob.auth)).status).toBe(403);
    expect((await request(ctx.app).patch(url).set(mallory.auth).send({ text: 'x' })).status).toBe(
      403,
    );
    expect((await request(ctx.app).patch(url).set(alice.auth).send({ text: '   ' })).status).toBe(
      400,
    );
    expect(
      (
        await request(ctx.app)
          .patch(`/chat/${chatId}/message/missing123`)
          .set(alice.auth)
          .send({ text: 'x' })
      ).status,
    ).toBe(404);
  });
});
