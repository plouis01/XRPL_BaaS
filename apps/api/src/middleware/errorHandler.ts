import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from '../logger.ts';

export const errorHandler: ErrorHandler = (err, c) => {
  logger.error({ err }, 'API error');

  // REVIEW.md MED-10: Hono's HTTPException carries the intended status and
  // body (e.g. 413 from bodyLimit, 401 from route-level assertions). Rewriting
  // every one of these to 500 masks the real failure — clients see "server
  // broke" for what is actually a well-formed client error. Pass through.
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // REVIEW.md MED-10: only dump `err.message` in DEVELOPMENT. Staging/preview
  // typically run with NODE_ENV=staging or unset — before this fix they were
  // treated as "non-prod" and happily echoed Drizzle errors (column names,
  // constraint hints, occasionally query fragments) to the client.
  const isDevelopment = process.env.NODE_ENV === 'development';
  const message = isDevelopment ? err.message || 'Internal server error' : 'Internal server error';
  return c.json({ error: message }, 500);
};
