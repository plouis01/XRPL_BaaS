// Per-request API key revocation re-check (PLAN.md §9.2 #6).
//
// The auth middleware checks revocation at auth time, but for high-value
// endpoints (payments, account deletion, token ops) we re-verify that the
// key hasn't been revoked between auth and handler execution. This closes
// the window where a key is revoked after auth but before the handler
// enqueues a real transaction.
//
// REVIEW.md LOW-03: previously every state-changing router mounted this
// middleware individually via `router.use('*', revocationCheck)`, which was
// an opt-in the next router author had to remember. The middleware is now
// mounted GLOBALLY on the /v1 chain in apps/api/src/index.ts. To avoid a
// DB round-trip on every read request (the original opt-in mounts were
// mostly on money-moving routes that also happened to expose GETs), this
// middleware now short-circuits on safe methods (GET/HEAD/OPTIONS). A
// key revoked mid-flight on a read surface only risks a moment of stale-
// cache reads — not a signed tx — so skipping is acceptable.

import { and, db, eq, isNull, schema } from '@railforge/db';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const revocationCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  // REVIEW.md LOW-03: skip safe methods — only re-check on state-changing
  // requests where a revoked key would otherwise submit a real tx.
  if (SAFE_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const apiKeyId = c.get('apiKeyId');

  let rows: { id: string }[];
  try {
    rows = await db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.id, apiKeyId),
          eq(schema.apiKeys.isActive, true),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .limit(1);
  } catch {
    // Fail closed: if the DB is unreachable, block the request.
    return c.json({ error: 'Service unavailable' }, 503);
  }

  if (rows.length === 0) {
    return c.json({ error: 'API key has been revoked' }, 401);
  }

  await next();
  return;
};
