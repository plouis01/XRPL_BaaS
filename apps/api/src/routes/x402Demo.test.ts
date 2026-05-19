// Route-level HTTP tests for /v1/x402-demo (Sprint 10 Day 4).
//
// The demo route is x402-gated — the handler only fires AFTER the
// middleware sets c.var.x402Intent. Tests here mount the route alone
// with a fake "middleware" that pre-seeds the intent on the context,
// to exercise the handler's response shape independently. The
// integration of middleware + handler is covered by the middleware
// tests (x402.test.ts) and the route's mount in index.ts.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../types.ts';

const TEST_INTENT_ID = 'x402_intent_ABCDEFGHJKMNPQRSTVWXYZ0123';
const TX_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const { default: x402DemoRoute } = await import('./x402Demo.ts');

function makeApp(
  intent: Record<string, unknown> | null = {
    id: TEST_INTENT_ID,
    consumingTxHash: TX_HASH,
    assetKind: 'xrp',
    amount: '10000',
  },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (intent) c.set('x402Intent', intent);
    await next();
  });
  app.route('/v1/x402-demo', x402DemoRoute);
  return app;
}

describe('POST /v1/x402-demo/echo', () => {
  it('echoes the request body and includes paid metadata', async () => {
    const payload = { hello: 'world', n: 42 };
    const res = await makeApp().request('/v1/x402-demo/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      echoed: payload,
      paid: {
        intent_id: TEST_INTENT_ID,
        tx_hash: TX_HASH,
        asset_kind: 'xrp',
        amount: '10000',
      },
    });
  });

  it('accepts an empty body and returns echoed:null', async () => {
    const res = await makeApp().request('/v1/x402-demo/echo', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echoed: unknown };
    expect(body.echoed).toBeNull();
  });

  it('still responds when no intent context is set (defensive — should never happen in prod)', async () => {
    // In production the middleware would prevent the handler from ever
    // running without an intent. This test pins the defensive behavior
    // so a missing context doesn't 500.
    const res = await makeApp(null).request('/v1/x402-demo/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paid: Record<string, unknown> };
    expect(body.paid).toEqual({
      intent_id: null,
      tx_hash: null,
      asset_kind: null,
      amount: null,
    });
  });
});
