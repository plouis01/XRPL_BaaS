import type { ErrorHandler } from 'hono';
import { logger } from '../logger.ts';

export const errorHandler: ErrorHandler = (err, c) => {
  logger.error({ err }, 'API error');
  // Never leak internal error details in production — schema names,
  // stack traces, or dependency errors could reveal attack surface.
  const message =
    process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error';
  return c.json({ error: message }, 500);
};
