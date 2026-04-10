// Per-request API key revocation re-check (PLAN.md §9.2 #6).
//
// The auth middleware checks revocation at auth time, but for high-value
// endpoints (payments, account deletion, token ops) we re-verify that the
// key hasn't been revoked between auth and handler execution. This closes
// the window where a key is revoked after auth but before the handler
// enqueues a real transaction.
//
// Apply this middleware to routes where the blast radius of a revoked-key
// request getting through is high.

import { and, db, eq, isNull, schema } from '@railforge/db';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.ts';

export const revocationCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKeyId = c.get('apiKeyId');

  const rows = await db
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

  if (rows.length === 0) {
    return c.json({ error: 'API key has been revoked' }, 401);
  }

  await next();
  return;
};
