import type { z } from 'zod';
import { ValidationError } from '../errors/app-error.js';

/** Cursors are opaque to clients: base64url-encoded JSON validated on the way back in. */
export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = schema.safeParse(decoded);
  if (!result.success) throw invalidCursor();
  return result.data;
}

function invalidCursor(): ValidationError {
  return new ValidationError([{ path: 'cursor', message: 'is invalid', location: 'query' }]);
}
