import type { Response } from 'express';

export interface SuccessBody<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export function sendSuccess(
  res: Response,
  data: unknown,
  options: { status?: number; meta?: Record<string, unknown> } = {},
): void {
  const body: SuccessBody<unknown> = { success: true, data };
  if (options.meta) body.meta = options.meta;
  res.status(options.status ?? 200).json(body);
}
