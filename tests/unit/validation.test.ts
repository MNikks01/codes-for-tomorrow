import { describe, expect, it } from 'vitest';
import { registerBodySchema } from '../../src/modules/auth/auth.schema.js';
import { createChatBodySchema } from '../../src/modules/chats/chat.schema.js';
import {
  MESSAGE_MAX_LENGTH,
  idempotencyKeySchema,
  lastSeenBodySchema,
  sendMessageBodySchema,
} from '../../src/modules/messages/message.schema.js';
import { ValidationError } from '../../src/shared/errors/app-error.js';
import { pageQuerySchema } from '../../src/shared/validation/common.schema.js';
import { parseInput } from '../../src/shared/validation/parse.js';

describe('message text validation', () => {
  const parse = (text: unknown) => sendMessageBodySchema.safeParse({ text });

  it('trims surrounding whitespace and normalises to NFC', () => {
    const result = parse('  café  ');
    expect(result.success && result.data.text).toBe('café');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   \n\t '],
    ['too long', 'a'.repeat(MESSAGE_MAX_LENGTH + 1)],
    ['NUL character', 'a\u0000b'],
    ['non-string', 42],
  ])('rejects %s text', (_label, text) => {
    expect(parse(text).success).toBe(false);
  });

  it('accepts exactly the maximum length', () => {
    expect(parse('a'.repeat(MESSAGE_MAX_LENGTH)).success).toBe(true);
  });

  it('rejects unknown fields (mass-assignment protection)', () => {
    expect(sendMessageBodySchema.safeParse({ text: 'hi', createdAt: '2020-01-01' }).success).toBe(
      false,
    );
  });
});

describe('request schemas', () => {
  it('validates UUIDs for chat creation', () => {
    expect(createChatBodySchema.safeParse({ userAId: 'abc', userBId: 'def' }).success).toBe(false);
  });

  it('lower-cases and trims emails and enforces password length', () => {
    const ok = registerBodySchema.safeParse({
      name: ' Ada ',
      email: '  Ada@Example.COM ',
      password: 'twelve-chars',
    });
    expect(ok.success && ok.data).toMatchObject({ name: 'Ada', email: 'ada@example.com' });
    expect(
      registerBodySchema.safeParse({ name: 'A', email: 'a@b.co', password: 'short' }).success,
    ).toBe(false);
    expect(
      registerBodySchema.safeParse({ name: 'A\u0007', email: 'a@b.co', password: 'twelve-chars' })
        .success,
    ).toBe(false);
  });

  it('bounds pagination', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(pageQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(pageQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
  });

  it('constrains idempotency keys and message ids', () => {
    expect(idempotencyKeySchema.safeParse('abc').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('valid-key_1234').success).toBe(true);
    expect(idempotencyKeySchema.safeParse(undefined).success).toBe(true);
    expect(lastSeenBodySchema.safeParse({ messageId: '../../etc' }).success).toBe(false);
  });

  it('parseInput reports field paths and location', () => {
    expect(() => parseInput(createChatBodySchema, { userAId: 'x' }, 'body')).toThrow(
      ValidationError,
    );
    try {
      parseInput(createChatBodySchema, { userAId: 'x' }, 'body');
    } catch (error) {
      expect((error as ValidationError).details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'userAId', location: 'body' })]),
      );
    }
  });
});
