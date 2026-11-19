import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, registerUser, type TestApp } from '../helpers/test-app.js';

let ctx: TestApp;

beforeAll(() => {
  ctx = createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

describe('auth API', () => {
  it('registers, logs in, and returns the profile', async () => {
    const user = await registerUser(ctx.app, 'Grace');
    const login = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email.toUpperCase(), password: user.password });
    expect(login.status).toBe(200);
    expect(login.body.data.user).toMatchObject({ id: user.id, name: 'Grace' });

    const me = await request(ctx.app).get('/api/v1/users/me').set(user.auth);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      success: true,
      data: { id: user.id, name: 'Grace', email: user.email, createdAt: expect.any(String) },
    });
  });

  it('rejects duplicate registration with 409', async () => {
    const user = await registerUser(ctx.app);
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ name: 'Again', email: user.email, password: 'another-long-password' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it.each([
    ['missing fields', {}],
    ['invalid email', { name: 'X', email: 'nope', password: 'long-enough-password' }],
    ['short password', { name: 'X', email: 'x@example.com', password: 'short' }],
    [
      'unknown field',
      { name: 'X', email: 'x@example.com', password: 'long-enough-pw', role: 'admin' },
    ],
  ])('rejects registration with %s', async (_label, body) => {
    const res = await request(ctx.app).post('/api/v1/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('rejects bad credentials with a generic 401', async () => {
    const user = await registerUser(ctx.app);
    const wrong = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'definitely-wrong' });
    const unknown = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: 'definitely-wrong' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const user = await registerUser(ctx.app);
    const first = await request(ctx.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: user.refreshToken });
    expect(first.status).toBe(200);
    const rotated = first.body.data.tokens.refreshToken as string;

    const replay = await request(ctx.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: user.refreshToken });
    expect(replay.status).toBe(401);

    const afterTheft = await request(ctx.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotated });
    expect(afterTheft.status).toBe(401);
  });

  it('logs out by revoking the refresh token', async () => {
    const user = await registerUser(ctx.app);
    const logout = await request(ctx.app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: user.refreshToken });
    expect(logout.status).toBe(204);
    const refresh = await request(ctx.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: user.refreshToken });
    expect(refresh.status).toBe(401);
  });
});
