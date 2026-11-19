import { pino, type Logger } from 'pino';

/** Paths censored everywhere in log output, including nested request bodies. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.privateKey',
  '*.private_key',
];

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: { service: 'nodejs-chat-backend' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
