import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import { toAppOptions } from './config/app.config.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { buildContainer, type Container } from './container.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;
/** Time for load balancers to observe the failing readiness probe before we stop listening. */
const DRAIN_DELAY_MS = Number(process.env['SHUTDOWN_DRAIN_MS'] ?? 5_000);

function readVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return typeof raw === 'object' &&
    raw !== null &&
    'version' in raw &&
    typeof raw.version === 'string'
    ? raw.version
    : 'unknown';
}

function main(): void {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
  if (env.NODE_ENV === 'production' && env.FIRESTORE_EMULATOR_HOST) {
    logger.warn('FIRESTORE_EMULATOR_HOST is set in production; Firestore data is not persistent');
  }

  const container = buildContainer(env, logger);
  const app = createApp(container.services, toAppOptions(env, readVersion()), logger);

  const server = app.listen(env.PORT, (error?: Error) => {
    if (error) {
      logger.fatal({ err: error }, 'Failed to start HTTP server');
      process.exit(1);
    }
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'HTTP server listening');
  });
  // Bound slow clients; keep-alive above typical load-balancer idle timeouts (60s).
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;

  registerShutdown(server, container, logger);
  // Opens DB pools and the Firestore gRPC channel now rather than on the first request.
  void container.services.readiness.report().then((report) => {
    logger.info({ dependencies: report.dependencies }, 'Startup dependency check');
  });
}

function registerShutdown(server: Server, container: Container, logger: Logger): void {
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      // A crash during shutdown must still surface as a failing exit code.
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }
    shuttingDown = true;
    logger.info({ reason }, 'Shutting down gracefully');
    container.services.readiness.markShuttingDown();

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    await sleep(DRAIN_DELAY_MS);
    // Stop accepting connections and let in-flight requests finish.
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeIdleConnections();
    });
    await container.close();
    clearTimeout(forceExit);
    logger.info('Shutdown complete');
    process.exit(Math.max(exitCode, Number(process.exitCode ?? 0)));
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.once('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

try {
  main();
} catch (error) {
  // Logger may not exist yet (e.g. invalid env); the message never contains secret values.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
