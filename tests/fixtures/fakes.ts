import { randomUUID } from 'node:crypto';
import type { AccessTokenIssuer } from '../../src/infrastructure/security/access-token.service.js';
import type { PasswordHasher } from '../../src/infrastructure/security/password-hasher.js';
import type {
  NewRefreshToken,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '../../src/modules/auth/auth.types.js';
import type {
  ChatAccess,
  ChatListPosition,
  ChatRepository,
  ChatView,
} from '../../src/modules/chats/chat.types.js';
import type { Message } from '../../src/modules/messages/message.types.js';
import type { NewUser, UserRecord, UserRepository } from '../../src/modules/users/user.types.js';
import { ConflictError } from '../../src/shared/errors/app-error.js';

/** In-memory fakes for unit tests. Real implementations are covered by integration tests. */

export class InMemoryUserRepository implements UserRepository {
  readonly users = new Map<string, UserRecord>();

  create(data: NewUser): Promise<UserRecord> {
    if ([...this.users.values()].some((user) => user.email === data.email)) {
      return Promise.reject(new ConflictError('An account with this email already exists'));
    }
    const now = new Date();
    const user = { id: randomUUID(), ...data, createdAt: now, updatedAt: now };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }

  findById(id: string): Promise<UserRecord | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    return Promise.resolve([...this.users.values()].find((user) => user.email === email) ?? null);
  }

  countExisting(ids: readonly string[]): Promise<number> {
    return Promise.resolve(new Set(ids.filter((id) => this.users.has(id))).size);
  }
}

export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  readonly tokens = new Map<string, RefreshTokenRecord & { tokenHash: string }>();
  /** Lets a test simulate losing the compare-and-swap race. */
  failNextConsume = false;

  create(data: NewRefreshToken): Promise<void> {
    const id = randomUUID();
    this.tokens.set(id, { id, ...data, revokedAt: null });
    return Promise.resolve();
  }

  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return Promise.resolve(
      [...this.tokens.values()].find((token) => token.tokenHash === tokenHash) ?? null,
    );
  }

  rotate(oldTokenId: string, at: Date, next: NewRefreshToken): Promise<boolean> {
    const token = this.tokens.get(oldTokenId);
    if (this.failNextConsume || !token || token.revokedAt) {
      this.failNextConsume = false;
      return Promise.resolve(false);
    }
    token.revokedAt = at;
    const id = randomUUID();
    this.tokens.set(id, { id, ...next, revokedAt: null });
    return Promise.resolve(true);
  }

  deleteExpired(userId: string, now: Date): Promise<void> {
    for (const [id, token] of this.tokens) {
      if (token.userId === userId && token.expiresAt < now) this.tokens.delete(id);
    }
    return Promise.resolve();
  }

  revokeFamily(familyId: string, at: Date): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.familyId === familyId) token.revokedAt ??= at;
    }
    return Promise.resolve();
  }
}

/** Deterministic, obviously-fake hasher: keeps unit tests fast and transparent. */
export class FakePasswordHasher implements PasswordHasher {
  verifyCalls = 0;

  hash(password: string): Promise<string> {
    return Promise.resolve(`hashed:${password}`);
  }

  verify(hash: string, password: string): Promise<boolean> {
    this.verifyCalls += 1;
    return Promise.resolve(hash === `hashed:${password}`);
  }
}

export class FakeTokenIssuer implements AccessTokenIssuer {
  readonly ttlSeconds = 900;

  sign(userId: string): string {
    return `access-token-for:${userId}`;
  }
}

export class InMemoryChatRepository implements ChatRepository {
  readonly chats = new Map<string, ChatView>();
  activityCalls: { chatId: string; messageId: string; at: Date }[] = [];

  addChat(memberIds: string[], lastActivityAt = new Date()): ChatView {
    const chat: ChatView = {
      id: randomUUID(),
      type: 'DIRECT',
      members: memberIds.map((userId) => ({ userId, name: 'n', joinedAt: lastActivityAt })),
      lastMessageId: null,
      lastMessageAt: null,
      lastActivityAt,
      createdAt: lastActivityAt,
      updatedAt: lastActivityAt,
    };
    this.chats.set(chat.id, chat);
    return chat;
  }

  createOrGetDirect(
    userAId: string,
    userBId: string,
  ): Promise<{ chat: ChatView; created: boolean }> {
    const existing = [...this.chats.values()].find((chat) => {
      const ids = chat.members.map((member) => member.userId);
      return ids.includes(userAId) && ids.includes(userBId);
    });
    if (existing) return Promise.resolve({ chat: existing, created: false });
    return Promise.resolve({ chat: this.addChat([userAId, userBId]), created: true });
  }

  getAccess(chatId: string, userId: string): Promise<ChatAccess> {
    const chat = this.chats.get(chatId);
    if (!chat) return Promise.resolve('CHAT_NOT_FOUND');
    return Promise.resolve(
      chat.members.some((member) => member.userId === userId) ? 'MEMBER' : 'NOT_MEMBER',
    );
  }

  listForUser(
    userId: string,
    limit: number,
    after?: ChatListPosition,
  ): Promise<{ chats: ChatView[]; hasMore: boolean }> {
    const sorted = [...this.chats.values()]
      .filter((chat) => chat.members.some((member) => member.userId === userId))
      .sort(
        (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || (a.id < b.id ? 1 : -1),
      )
      .filter(
        (chat) =>
          !after ||
          chat.lastActivityAt < after.lastActivityAt ||
          (chat.lastActivityAt.getTime() === after.lastActivityAt.getTime() && chat.id < after.id),
      );
    return Promise.resolve({ chats: sorted.slice(0, limit), hasMore: sorted.length > limit });
  }

  recordMessageActivity(chatId: string, messageId: string, at: Date): Promise<void> {
    this.activityCalls.push({ chatId, messageId, at });
    return Promise.resolve();
  }
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  const id = overrides.id ?? randomUUID().replaceAll('-', '').slice(0, 20);
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00.000Z');
  return {
    id,
    chatId: randomUUID(),
    senderId: randomUUID(),
    text: 'hello',
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    position: { seconds: Math.floor(createdAt.getTime() / 1000), nanos: 0, id },
    ...overrides,
  };
}
