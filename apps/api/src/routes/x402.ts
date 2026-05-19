// x402 management + remote verifier routes. SPRINT_10_PLAN.md §4.5.
//
// Mounted under /v1/x402 — every route here is API-key-authenticated
// (Mode B usage). The Mode A demo endpoint (/v1/x402-demo/echo) lives
// in routes/x402Demo.ts and is x402-gated (no API key).
//
// POST   /v1/x402/verify          — remote verifier endpoint a client
//                                   calls from their backend after their
//                                   own x402-gated server receives an
//                                   X-PAYMENT header. Returns
//                                   { ok, reason?, ledger_index? }.
// GET    /v1/x402/intents/:id     — read an intent's status for debug /
//                                   dashboard inspection.
// POST   /v1/x402/routes          — register a gated path on this client.
// GET    /v1/x402/routes          — list this client's routes.
// DELETE /v1/x402/routes/:id      — soft-delete (is_active=false).

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  createRoute,
  deleteRoute,
  findIntent,
  listRoutes,
} from '../services/x402Intent.service.ts';
import { verifyPayment } from '../services/x402Verify.service.ts';
import type { AppEnv } from '../types.ts';
import { createX402RouteSchema, verifyX402Schema } from '../validators/schemas.ts';

const x402 = new Hono<AppEnv>();

// ── Remote verifier ─────────────────────────────────────────────────────────

x402.post('/verify', zValidator('json', verifyX402Schema), async (c) => {
  const body = c.req.valid('json');
  const result = await verifyPayment(body.intent_id, body.tx_hash);
  if (result.ok) {
    return c.json({
      ok: true,
      ledger_index: result.ledgerIndex,
      intent_id: result.intent.id,
      consumed_at: result.intent.consumedAt?.toISOString() ?? null,
    });
  }
  // The verify endpoint returns 200 with `{ok:false,reason}` rather than
  // a 4xx — clients consume the boolean and the reason maps cleanly to
  // their own error UX. Returning 4xx would conflate "your request was
  // bad" with "the payment they sent you was bad."
  return c.json({ ok: false, reason: result.reason });
});

// ── Intent inspection ───────────────────────────────────────────────────────

x402.get('/intents/:id', async (c) => {
  const id = c.req.param('id');
  const intent = await findIntent(id);
  if (!intent) return c.json({ error: 'Not found' }, 404);
  // Cross-tenant guard: a Mode-A intent (clientId set) is only visible to
  // its owning client. Mode-B intents (clientId null) are visible to any
  // authenticated reader — they're not bound to a tenant on the way in.
  const clientId = c.get('clientId');
  if (intent.clientId !== null && intent.clientId !== clientId) {
    return c.json({ error: 'Not found' }, 404);
  }
  return c.json({
    id: intent.id,
    resource_path: intent.resourcePath,
    payee_address: intent.payeeAddress,
    asset_kind: intent.assetKind,
    asset_key: intent.assetKey,
    amount: intent.amount,
    destination_tag: intent.destinationTag,
    expires_at: intent.expiresAt.toISOString(),
    consumed_at: intent.consumedAt?.toISOString() ?? null,
    consuming_tx_hash: intent.consumingTxHash,
    created_at: intent.createdAt.toISOString(),
  });
});

// ── Route CRUD ──────────────────────────────────────────────────────────────

x402.post('/routes', zValidator('json', createX402RouteSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const route = await createRoute({
      clientId,
      pathPattern: body.path_pattern,
      payeeAddress: body.payee_address,
      asset: body.asset,
      amount: body.amount,
    });
    return c.json(
      {
        id: route.id,
        path_pattern: route.pathPattern,
        payee_address: route.payeeAddress,
        asset_kind: route.assetKind,
        asset_key: route.assetKey,
        price_amount: route.priceAmount,
        is_active: route.isActive,
        created_at: route.createdAt.toISOString(),
      },
      201,
    );
  } catch (err) {
    // Postgres unique-violation: client tried to register the same
    // path_pattern twice. Surface as 409.
    if ((err as { code?: string })?.code === '23505') {
      return c.json({ error: 'Route already exists for this path' }, 409);
    }
    throw err;
  }
});

x402.get('/routes', async (c) => {
  const clientId = c.get('clientId');
  const routes = await listRoutes(clientId);
  return c.json({
    routes: routes.map((r) => ({
      id: r.id,
      path_pattern: r.pathPattern,
      payee_address: r.payeeAddress,
      asset_kind: r.assetKind,
      asset_key: r.assetKey,
      price_amount: r.priceAmount,
      is_active: r.isActive,
      created_at: r.createdAt.toISOString(),
    })),
  });
});

x402.delete('/routes/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  const ok = await deleteRoute(clientId, id);
  if (!ok) return c.json({ error: 'Not found' }, 404);
  return c.body(null, 204);
});

export default x402;
