import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from '../logger.ts';

/**
 * Drizzle wraps every DB error in a generic `Error: Failed query: <SQL>` —
 * the actual `pg` error (with `.code`, `.detail`, `.constraint`, etc.) is
 * stashed on `err.cause`. The wrapper hides the discriminator we actually
 * need to debug ("column does not exist" vs "duplicate key" vs "fk
 * violation"). Surfacing the cause's `.code`/`.detail` in the log line
 * makes today's symptom-to-root-cause path a 30-second job instead of a
 * fishing expedition through the SQL string. Server-side log only — the
 * client response stays sanitized per MED-10.
 */
function unwrapDrizzleCause(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof Error)) return null;
  if (!err.message?.startsWith('Failed query:')) return null;
  const cause = (err as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return null;
  const c = cause as Record<string, unknown>;
  // Most pg errors carry these; missing fields are fine — pino skips
  // undefined values. We deliberately do NOT include `query`/`params`
  // because those are already in err.message.
  return {
    pgCode: c.code,
    pgDetail: c.detail,
    pgHint: c.hint,
    pgTable: c.table,
    pgColumn: c.column,
    pgConstraint: c.constraint,
    pgMessage: c.message,
  };
}

export const errorHandler: ErrorHandler = (err, c) => {
  const pgFields = unwrapDrizzleCause(err);
  if (pgFields) {
    logger.error({ err, pg: pgFields }, 'API error (DB-layer)');
  } else {
    logger.error({ err }, 'API error');
  }

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
