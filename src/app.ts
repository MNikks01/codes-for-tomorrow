import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { AppOptions } from './config/app.config.js';
import type { Services } from './container.js';
import { buildOpenApiDocument } from './docs/openapi.js';
import { createAuthenticate } from './middleware/authenticate.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { createRateLimiter, loginAccountKey } from './middleware/rate-limit.js';
import { resolveRequestId } from './middleware/request-id.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { ChatController } from './modules/chats/chat.controller.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { MessageController } from './modules/messages/message.controller.js';
import { UserController } from './modules/users/user.controller.js';
import { createApiRouter } from './routes/index.js';

export function createApp(services: Services, options: AppOptions, logger: Logger): Express {
  const app = express();
  app.disable('x-powered-by');
  // Only trust X-Forwarded-For from one proxy hop, otherwise clients could spoof their IP.
  app.set('trust proxy', options.trustProxy ? 1 : false);

  app.use(
    pinoHttp({
      logger,
      genReqId: resolveRequestId,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        return res.statusCode >= 400 ? 'warn' : 'info';
      },
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: options.corsOrigins.length > 0 ? options.corsOrigins : false,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'RateLimit', 'RateLimit-Policy'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: options.bodyLimit, strict: true }));

  app.use(createHealthRouter(services.readiness, options.version));

  if (options.enableApiDocs) {
    const document = buildOpenApiDocument(options.version);
    app.get('/docs/openapi.json', (_req, res) => {
      res.json(document);
    });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(document));
  }

  const api = createApiRouter({
    controllers: {
      auth: new AuthController(services.authService),
      users: new UserController(services.userService, services.chatService),
      chats: new ChatController(services.chatService),
      messages: new MessageController(services.messageService),
    },
    authenticate: createAuthenticate(services.accessTokens),
    authLimiters: {
      perIp: createRateLimiter(options.authRateLimit),
      perAccount: createRateLimiter(options.authRateLimit, loginAccountKey),
    },
  });
  // Applied once, before both mounts, so every request is counted exactly once.
  app.use(createRateLimiter(options.apiRateLimit));
  app.use('/api/v1', api);
  // Unversioned alias so the assignment's literal paths (e.g. POST /chat/create) also work.
  app.use(api);

  app.use(notFound);
  app.use(createErrorHandler(logger));
  return app;
}
