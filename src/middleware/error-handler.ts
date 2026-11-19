import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { isDatabaseUnavailable } from '../infrastructure/postgres/prisma-errors.js';
import { AppError, DatabaseError } from '../shared/errors/app-error.js';

interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof error.type === 'string' &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isBodyParserError(error) && error.status >= 400 && error.status < 500) {
    if (error.type === 'entity.too.large') {
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    return new AppError(error.status, 'MALFORMED_REQUEST', 'Malformed request body');
  }
  if (isDatabaseUnavailable(error)) return new DatabaseError({ cause: error });
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

/**
 * Single place where errors become HTTP responses. Only AppError messages reach
 * clients; stack traces, SQL and Firebase errors are logged, never returned.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    const appError = toAppError(error);
    const log = (req.log as Logger | undefined) ?? logger;
    const context = { code: appError.code, statusCode: appError.statusCode };

    if (appError.statusCode >= 500) {
      log.error({ ...context, err: error }, 'Request failed');
    } else if (appError.statusCode === 401 || appError.statusCode === 403) {
      log.warn(context, 'Request denied');
    }

    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(appError.statusCode).json({
      success: false,
      error: { code: appError.code, message: appError.message, details: appError.details },
    });
  };
}
