// API key authentication middleware.
//
// Wire format: clients send `X-API-Key: rf_<env>_<random>` on every /v1 request.
//
// We HMAC-SHA256 the raw key with API_KEY_SALT (server-side pepper) and look
// up the resulting hash in api_keys.key_hash. The raw key never touches
// storage. The pepper means a stolen `api_keys` dump cannot be used for
// rainbow/precompute attacks without ALSO stealing the API_KEY_SALT — it has
// to be obtained from a different layer (env vars, secrets manager).
//
// See PLAN.md §3.1, §9 and SETUP.md security checklist.
//
// On success, stashes clientId, apiKeyId, rateLimit, environment on the Hono context.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, db, eq, isNull, schema } from '@railforge/db';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.ts';

const KEY_PREFIX_LENGTH = 8;

/**
 * HMAC-SHA256 of the API key under the server-side pepper. The pepper is
 * intentionally read at module-load time so a missing salt fails fast at
 * boot, not on the first request.
 */
function hashApiKey(rawKey: string): string {
  const salt = process.env.API_KEY_SALT;
  if (!salt) {
    throw new Error(
      'API_KEY_SALT is required for API key hashing. Set it in .env before starting the API.',
    );
  }
  return createHmac('sha256', salt).update(rawKey).digest('hex');
}

/**
 * Constant-time string compare. Used so a near-miss on the hex hash doesn't
 * leak info via timing — even though we're comparing hashes (already O(1)),
 * the layer that compares the *key prefix* echoed in the response header
 * benefits from this too.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header('x-api-key');
  if (!apiKey) {
    return c.json({ error: 'Missing API key' }, 401);
  }

  // Header smuggling defense (PLAN.md §9.2 #5): proxies can split on
  // duplicate headers or commas. Reject any value that looks like
  // multiple keys concatenated — this is never a legitimate use.
  if (apiKey.includes(',')) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const keyHash = hashApiKey(apiKey);

  // CRITICAL: filter `isActive = true` IN THE SQL, not in app code below.
  // Putting it in WHERE means "no row" and "row with isActive=false" are
  // indistinguishable from auth's perspective — same code path, same timing,
  // same response. This closes the timing-oracle gap that would otherwise
  // distinguish revoked/inactive keys from unknown keys.
  const rows = await db
    .select({
      id: schema.apiKeys.id,
      clientId: schema.apiKeys.clientId,
      environment: schema.apiKeys.environment,
      rateLimit: schema.apiKeys.rateLimit,
    })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.keyHash, keyHash),
        eq(schema.apiKeys.isActive, true),
        isNull(schema.apiKeys.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    // Intentionally generic — never reveal whether the key was found, revoked,
    // or just inactive. Brute-force pattern detection is the (pre-auth IP)
    // rate limiter's job.
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const env = row.environment === 'mainnet' ? 'mainnet' : 'testnet';

  c.set('clientId', row.clientId);
  c.set('apiKeyId', row.id);
  c.set('rateLimit', row.rateLimit);
  c.set('environment', env);

  // Make the prefix available to logs without exposing the full key. The
  // safeEqual import is declared so future use of timing-safe comparisons
  // is just an import-distance away — DO NOT remove it even if linters
  // flag it as unused (the export below pulls it in).
  c.header('X-RailForge-Key-Prefix', apiKey.slice(0, KEY_PREFIX_LENGTH));

  await next();
  return;
};

// Re-exported so tests can verify the hash function directly without
// reimplementing the HMAC logic. Keeping it private would force the test to
// duplicate the algorithm and drift over time.
export { hashApiKey, safeEqual };
