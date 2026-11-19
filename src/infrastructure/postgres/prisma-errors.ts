import { Prisma } from '../../generated/prisma/client.js';

/** Prisma error codes that mean "the database cannot be reached right now". */
const CONNECTIVITY_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const CONNECTIVITY_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return CONNECTIVITY_CODES.has(error.code);
  }
  return hasConnectivityErrno(error, 0);
}

// Driver-adapter errors wrap the underlying socket error; walk the cause chain briefly.
function hasConnectivityErrno(error: unknown, depth: number): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false;
  if ('code' in error && typeof error.code === 'string' && CONNECTIVITY_ERRNOS.has(error.code)) {
    return true;
  }
  if (error instanceof AggregateError) {
    return error.errors.some((inner) => hasConnectivityErrno(inner, depth + 1));
  }
  return 'cause' in error && hasConnectivityErrno(error.cause, depth + 1);
}
