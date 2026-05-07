// Dashboard signup endpoint (testnet beta).
//
// Lets the login UI mint a fresh testnet client + API key without shelling
// out to scripts/seed-dev.ts. Gated by index.ts to non-prod by default; can
// be opted into on a production deployment with `RAILFORGE_ALLOW_SIGNUP=1`
// (testnet beta / early access). The route literally is not registered
// when the gate is closed, so callers see a 404. A real signup flow
// (email verification, captcha, plan selection) is still deferred.
//
//   POST /v1/dashboard/signup    { email, name } → { api_key, client_id, environment }
//
// The endpoint returns the raw key once, in the response body — there is
// no persistent server-side stash. The caller is expected to immediately
// POST it to /v1/dashboard/session to set the httpOnly session cookie.
//
// Security posture:
//  - 404 when the gate is closed (production without RAILFORGE_ALLOW_SIGNUP).
//  - Pre-auth (no /v1 chain). Requests still hit the IP rate limiter.
//  - testnet keys only. No way for a caller to mint a `rf_live_` key here.
//  - HMAC scheme is the same as auth.ts (hashApiKey), so the seeded key
//    auths the same way as one minted by /v1/dashboard/keys.

import { randomBytes } from 'node:crypto';
import { db, eq, schema } from '@railforge/db';
import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.ts';
import { hashApiKey } from '../middleware/auth.ts';
import type { AppEnv } from '../types.ts';

const signup = new Hono<AppEnv>();

const signupSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(120),
});

signup.post('/', async (c) => {
  let body: { email: string; name: string };
  try {
    body = signupSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'invalid request body' }, 400);
  }

  // Match seed-dev.ts key shape: rf_test_<44-char-base64url>.
  const rawKey = `rf_test_${randomBytes(32).toString('base64url')}`;
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 8);

  let clientId: string;
  try {
    const existing = await db
      .select({ id: schema.clients.id })
      .from(schema.clients)
      .where(eq(schema.clients.email, body.email))
      .limit(1);

    if (existing[0]) {
      clientId = existing[0].id;
    } else {
      const inserted = await db
        .insert(schema.clients)
        .values({ name: body.name, email: body.email, plan: 'free' })
        .returning({ id: schema.clients.id });
      const insertedId = inserted[0]?.id;
      if (!insertedId) {
        logger.error({ email: body.email }, 'dashboard signup client insert returned no id');
        return c.json({ error: 'Service unavailable' }, 503);
      }
      clientId = insertedId;
    }

    await db.insert(schema.apiKeys).values({
      clientId,
      keyHash,
      keyPrefix,
      label: `dashboard signup ${new Date().toISOString()}`,
      environment: 'testnet',
      rateLimit: 1000,
      isActive: true,
    });
  } catch (err) {
    logger.error({ err }, 'dashboard signup DB write failed');
    return c.json({ error: 'Service unavailable' }, 503);
  }

  logger.info(
    { clientId, keyPrefix, email: body.email },
    'dashboard signup created client + testnet key',
  );

  return c.json(
    {
      api_key: rawKey,
      client_id: clientId,
      environment: 'testnet' as const,
    },
    201,
  );
});

export default signup;
