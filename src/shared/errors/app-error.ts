export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'MALFORMED_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'DATABASE_UNAVAILABLE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  path: string;
  message: string;
  location?: string;
}

/** Base class for errors that are safe to show to API clients. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: ErrorDetail[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[], message = 'Invalid request') {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(
    message = 'Authentication required',
    code: 'UNAUTHENTICATED' | 'TOKEN_EXPIRED' | 'INVALID_CREDENTIALS' = 'UNAUTHENTICATED',
  ) {
    super(401, code, message);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'You are not allowed to perform this action') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

export class UnprocessableError extends AppError {
  constructor(message: string) {
    super(422, 'UNPROCESSABLE', message);
  }
}

export class DatabaseError extends AppError {
  constructor(options?: ErrorOptions) {
    super(503, 'DATABASE_UNAVAILABLE', 'Database is temporarily unavailable', [], options);
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, options?: ErrorOptions) {
    super(503, 'DEPENDENCY_UNAVAILABLE', `${service} is temporarily unavailable`, [], options);
  }
}
