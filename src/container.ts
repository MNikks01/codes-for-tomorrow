import type { Logger } from 'pino';
import type { Env } from './config/env.js';
import { createFirestore } from './infrastructure/firestore/firestore.client.js';
import { FirestoreLastSeenStore } from './infrastructure/firestore/last-seen.store.js';
import { FirestoreMessageStore } from './infrastructure/firestore/message.store.js';
import { FirestoreReceiptStore } from './infrastructure/firestore/receipt.store.js';
import { createPrismaClient } from './infrastructure/postgres/prisma.client.js';
import { AccessTokenService } from './infrastructure/security/access-token.service.js';
import {
  Argon2PasswordHasher,
  type PasswordHasher,
} from './infrastructure/security/password-hasher.js';
import { PrismaRefreshTokenRepository } from './modules/auth/auth.repository.js';
import { AuthService } from './modules/auth/auth.service.js';
import { PrismaChatRepository } from './modules/chats/chat.repository.js';
import { ChatService } from './modules/chats/chat.service.js';
import { ReadinessService } from './modules/health/readiness.service.js';
import { MessageService } from './modules/messages/message.service.js';
import type {
  LastSeenStore,
  MessageStore,
  ReceiptStore,
} from './modules/messages/message.types.js';
import { PrismaUserRepository } from './modules/users/user.repository.js';
import { UserService } from './modules/users/user.service.js';

export interface Services {
  authService: AuthService;
  userService: UserService;
  chatService: ChatService;
  messageService: MessageService;
  readiness: ReadinessService;
  accessTokens: AccessTokenService;
}

export interface Container {
  services: Services;
  close(): Promise<void>;
}

/** Test seams: swap infrastructure at the boundary without touching business logic. */
export interface ContainerOverrides {
  passwordHasher?: PasswordHasher;
  messageStore?: MessageStore;
  receiptStore?: ReceiptStore;
  lastSeenStore?: LastSeenStore;
}

/** Composition root: the only place concrete infrastructure is chosen. */
export function buildContainer(
  env: Env,
  logger: Logger,
  overrides: ContainerOverrides = {},
): Container {
  const prisma = createPrismaClient(env.DATABASE_URL, env.DATABASE_POOL_MAX);
  const firestore = createFirestore({
    projectId: env.FIREBASE_PROJECT_ID,
    emulatorHost: env.FIRESTORE_EMULATOR_HOST,
    serviceAccountBase64: env.FIREBASE_SERVICE_ACCOUNT_BASE64,
  });

  const users = new PrismaUserRepository(prisma);
  const accessTokens = new AccessTokenService({
    secret: env.JWT_ACCESS_SECRET,
    ttlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
  const chatService = new ChatService(new PrismaChatRepository(prisma), users);

  const services: Services = {
    accessTokens,
    authService: new AuthService(
      users,
      new PrismaRefreshTokenRepository(prisma),
      overrides.passwordHasher ?? new Argon2PasswordHasher(),
      accessTokens,
      { refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS },
    ),
    userService: new UserService(users),
    chatService,
    messageService: new MessageService(
      chatService,
      overrides.messageStore ?? new FirestoreMessageStore(firestore.db),
      overrides.receiptStore ?? new FirestoreReceiptStore(firestore.db),
      overrides.lastSeenStore ?? new FirestoreLastSeenStore(firestore.db),
      logger,
    ),
    readiness: new ReadinessService(
      [
        {
          name: 'postgres',
          check: async () => {
            await prisma.$queryRaw`SELECT 1`;
          },
        },
        {
          name: 'firestore',
          check: async () => {
            await firestore.db.collection('_health').limit(1).get();
          },
        },
      ],
      { cacheTtlMs: 5_000, timeoutMs: 5_000 },
      logger,
    ),
  };

  return {
    services,
    close: async () => {
      await Promise.allSettled([prisma.$disconnect(), firestore.close()]);
    },
  };
}
