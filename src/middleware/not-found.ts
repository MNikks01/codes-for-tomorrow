import type { RequestHandler } from 'express';
import { NotFoundError } from '../shared/errors/app-error.js';

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError('Route'));
};
