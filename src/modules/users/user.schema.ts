import { z } from 'zod';
import { uuidSchema } from '../../shared/validation/common.schema.js';

export const userParamsSchema = z.strictObject({ userId: uuidSchema });
