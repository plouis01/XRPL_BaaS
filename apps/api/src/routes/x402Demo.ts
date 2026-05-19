// Mode A x402 demo route. SPRINT_10_PLAN.md §4.6.
//
// Mounted under /v1/x402-demo. The x402 middleware (configured in
// index.ts behind X402_DEMO_PAYEE) runs FIRST and gates every request
// here — if no valid X-PAYMENT header is present the middleware returns
// 402 and this handler never executes.
//
// POST /echo — returns the request body verbatim, plus the consuming
// tx hash header. Purpose: a deterministic, tiny target for SDK
// integration tests (Day 6) + a public demo URL anyone can call.
//
// There is NO auth middleware on this router — payment IS the auth.

import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';

const x402Demo = new Hono<AppEnv>();

x402Demo.post('/echo', async (c) => {
  // The middleware verified a valid X-PAYMENT before we got here. The
  // intent has already been atomically consumed by verifyPayment — this
  // handler can rely on `c.get('x402Intent')` being set.
  const intent = c.get('x402Intent') as
    | {
        id: string;
        consumingTxHash: string | null;
        amount: string;
        assetKind: string;
      }
    | undefined;
  // Read the request body. Pure echo — no schema validation here; the
  // demo's only purpose is to round-trip arbitrary JSON.
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    // Empty / non-JSON body is fine — echo back null.
  }
  return c.json({
    echoed: body,
    paid: {
      intent_id: intent?.id ?? null,
      tx_hash: intent?.consumingTxHash ?? null,
      asset_kind: intent?.assetKind ?? null,
      amount: intent?.amount ?? null,
    },
  });
});

export default x402Demo;
