import type { z } from 'zod';
import { ValidationError } from '../errors/app-error.js';

export type RequestLocation = 'body' | 'params' | 'query' | 'headers';

/** Runtime-validates untrusted input; TypeScript types alone guarantee nothing at runtime. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
  location: RequestLocation,
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || location,
      message: issue.message,
      location,
    })),
  );
}
