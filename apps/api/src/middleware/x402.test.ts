// Tests for the x402 gating middleware. SPRINT_10_PLAN.md §4.4.
//
// Strategy: stub the two services the middleware delegates to (createIntent
// + verifyPayment) so each test pins exactly which failure branch it
// exercises. Hono drives the request shape end-to-end (real header parsing,
// real status code propagation).

import { Hono } from 'hono';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

import { encodePaymentHeader, intentIdToDestinationTag } from '@railforge/xrpl-core';

const mockRedis = new RedisMock();
vi.mock('../redis.ts', () => ({
  getRedis: () => mockRedis,
  disconnectRedis: async () => {},
}));

vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ── Service stubs ──────────────────────────────────────────────────────────
// Each test reaches into these to wire fixtures. createIntent always returns
// a fresh row with a deterministic id; verifyPayment returns whatever the
// test pre-wired.

const TEST_INTENT_ID = 'x402_intent_ABCDEFGHJKMNPQRSTVWXYZ0123';
const TEST_TAG = intentIdToDestinationTag(TEST_INTENT_ID);
const PAYEE = 'rEHMTjmCNgxiGzgUTpV4Y1MwYpFpYz7e7p';

interface FakeIntent {
  id: string;
  clientId: string | null;
  resourcePath: string;
  payeeAddress: string;
  assetKind: 'xrp' | 'mpt';
  assetKey: string | null;
  amount: string;
  destinationTag: number;
  expiresAt: Date;
  consumedAt: Date | null;
  consumingTxHash: string | null;
  createdAt: Date;
}

function makeFakeIntent(overrides: Partial<FakeIntent> = {}): FakeIntent {
  return {
    id: TEST_INTENT_ID,
    clientId: null,
    resourcePath: '/echo',
    payeeAddress: PAYEE,
    assetKind: 'xrp',
    assetKey: null,
    amount: '10000',
    destinationTag: TEST_TAG,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    consumingTxHash: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const stubs = {
  intent: makeFakeIntent(),
  // verifyResult is what verifyPayment returns. Default to ok-with-intent so
  // happy-path tests don't have to rewire.
  verifyResult: null as
    | { ok: true; intent: FakeIntent; ledgerIndex: number | null }
    | { ok: false; reason: string }
    | null,
  createCalls: [] as Array<unknown>,
  verifyCalls: [] as Array<{ intentId: string; txHash: string }>,
};

vi.mock('../services/x402Intent.service.ts', () => ({
  createIntent: vi.fn(async (input: unknown) => {
    stubs.createCalls.push(input);
    return makeFakeIntent({
      resourcePath: (input as { resourcePath: string }).resourcePath,
    });
  }),
}));

vi.mock('../services/x402Verify.service.ts', () => ({
  verifyPayment: vi.fn(async (intentId: string, txHash: string) => {
    stubs.verifyCalls.push({ intentId, txHash });
    return stubs.verifyResult;
  }),
}));

// trustedProxy.getClientIp is exercised by other tests; we just need a
// stable IP per request so the intent-rate-limit bucket can be steered.
vi.mock('./trustedProxy.ts', () => ({
  getClientIp: (c: { req: { header: (k: string) => string | undefined } }) =>
    c.req.header('cf-connecting-ip') ?? '127.0.0.1',
}));

const { createX402Middleware } = await import('./x402.ts');

// ── Test scaffold ──────────────────────────────────────────────────────────

const STATIC_QUOTE = {
  payeeAddress: PAYEE,
  asset: 'XRP',
  amount: '10000',
  clientId: null,
};

function makeApp(
  opts: {
    resolveRoute?: (path: string) => Promise<typeof STATIC_QUOTE | null>;
    intentsPerMinutePerIp?: number;
  } = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(
    '*',
    createX402Middleware({
      resolveRoute: opts.resolveRoute ?? (async () => STATIC_QUOTE),
      intentsPerMinutePerIp: opts.intentsPerMinutePerIp ?? 30,
      facilitatorVerifyUrl: 'https://example.test/v1/x402/verify',
    }),
  );
  app.get('/echo', (c) => {
    const intent = c.get('x402Intent') as FakeIntent | undefined;
    return c.json({ ok: true, intent_id: intent?.id ?? null });
  });
  return app;
}

const TX_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(async () => {
  await mockRedis.flushall();
  stubs.intent = makeFakeIntent();
  stubs.verifyResult = null;
  stubs.createCalls = [];
  stubs.verifyCalls = [];
});
afterEach(() => {
  vi.clearAllMocks();
});

// ── 402 issuance (no header) ───────────────────────────────────────────────

describe('x402 middleware — no X-PAYMENT header', () => {
  it('returns 402 with intent + WWW-Authenticate when route resolves', async () => {
    const app = makeApp();
    const res = await app.request('/echo');
    expect(res.status).toBe(402);
    expect(res.headers.get('www-authenticate')).toMatch(/^X402 realm="\/echo"$/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.x402_version).toBe(1);
    expect(body.intent_id).toBe(TEST_INTENT_ID);
    expect(body.resource).toBe('/echo');
    expect(body.payee).toBe(PAYEE);
    expect(body.asset).toBe('XRP');
    expect(body.amount).toBe('10000');
    expect(body.destination_tag).toBe(TEST_TAG);
    expect(typeof body.expires_at).toBe('string');
    expect(body.facilitator_verify_url).toBe('https://example.test/v1/x402/verify');
    // Reason is absent on the FIRST 402 — only re-quotes emit it.
    expect(body.reason).toBeUndefined();
    expect(stubs.createCalls).toHaveLength(1);
  });

  it('returns 404 when route does not resolve (no enumeration oracle)', async () => {
    const app = makeApp({ resolveRoute: async () => null });
    const res = await app.request('/echo');
    expect(res.status).toBe(404);
    // Crucially NOT 402 — wouldn't want a probe to map gated routes by
    // status code.
    expect(stubs.createCalls).toHaveLength(0);
  });
});

// ── X-PAYMENT happy path ───────────────────────────────────────────────────

describe('x402 middleware — valid X-PAYMENT', () => {
  it('passes through to the handler when verifyPayment ok', async () => {
    stubs.verifyResult = {
      ok: true,
      intent: makeFakeIntent({
        consumedAt: new Date(),
        consumingTxHash: TX_HASH,
      }),
      ledgerIndex: 12345,
    };
    const app = makeApp();
    const header = encodePaymentHeader(TEST_INTENT_ID, TX_HASH);
    const res = await app.request('/echo', {
      headers: { 'x-payment': header },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; intent_id: string };
    expect(body.ok).toBe(true);
    expect(body.intent_id).toBe(TEST_INTENT_ID);
    expect(res.headers.get('x-payment-intent-id')).toBe(TEST_INTENT_ID);
    expect(res.headers.get('x-payment-tx-hash')).toBe(TX_HASH);
    expect(stubs.verifyCalls).toEqual([{ intentId: TEST_INTENT_ID, txHash: TX_HASH }]);
    // No new intent minted on a successful verify.
    expect(stubs.createCalls).toHaveLength(0);
  });
});

// ── X-PAYMENT failure paths ────────────────────────────────────────────────

describe('x402 middleware — malformed X-PAYMENT', () => {
  it('re-quotes 402 with reason=malformed_header on garbage base64', async () => {
    const app = makeApp();
    const res = await app.request('/echo', {
      headers: { 'x-payment': 'not-base64!!!' },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason: string; intent_id: string };
    expect(body.reason).toBe('malformed_header');
    expect(body.intent_id).toBe(TEST_INTENT_ID);
    // verifyPayment was NOT called — we couldn't even decode.
    expect(stubs.verifyCalls).toHaveLength(0);
    expect(stubs.createCalls).toHaveLength(1);
  });

  it('re-quotes 402 with reason=malformed_header on bad JSON inside base64', async () => {
    const bad = Buffer.from('not json', 'utf8').toString('base64');
    const app = makeApp();
    const res = await app.request('/echo', { headers: { 'x-payment': bad } });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('malformed_header');
  });
});

describe('x402 middleware — verifier rejection', () => {
  it.each([
    'not_found',
    'already_consumed',
    'expired',
    'tx_lookup_failed',
    'not_validated',
    'not_payment',
    'payee_mismatch',
    'tag_mismatch',
    'asset_mismatch',
    'amount_short',
  ])('re-quotes 402 with reason=%s', async (reason) => {
    stubs.verifyResult = { ok: false, reason };
    const app = makeApp();
    const header = encodePaymentHeader(TEST_INTENT_ID, TX_HASH);
    const res = await app.request('/echo', {
      headers: { 'x-payment': header },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason: string; intent_id: string };
    expect(body.reason).toBe(reason);
    // Fresh intent minted on the re-quote.
    expect(stubs.createCalls).toHaveLength(1);
  });
});

// ── Rate limit ─────────────────────────────────────────────────────────────

describe('x402 middleware — intent rate limit', () => {
  it('returns 429 when intent issuance exceeds the per-IP ceiling', async () => {
    const app = makeApp({ intentsPerMinutePerIp: 3 });
    const ip = { 'cf-connecting-ip': '203.0.113.10' };

    // First 3 requests succeed (each returns a 402).
    for (let i = 0; i < 3; i++) {
      const r = await app.request('/echo', { headers: ip });
      expect(r.status).toBe(402);
    }

    // 4th hits the ceiling.
    const blocked = await app.request('/echo', { headers: ip });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
  });

  it('does not budget against IP rate-limit when verify succeeds (no mint)', async () => {
    stubs.verifyResult = {
      ok: true,
      intent: makeFakeIntent({
        consumedAt: new Date(),
        consumingTxHash: TX_HASH,
      }),
      ledgerIndex: 1,
    };
    const app = makeApp({ intentsPerMinutePerIp: 1 });
    const header = encodePaymentHeader(TEST_INTENT_ID, TX_HASH);
    const ip = { 'cf-connecting-ip': '203.0.113.11', 'x-payment': header };

    // Even though the ceiling is 1, 10 successful verifies don't trigger
    // it — the rate limit only fires on the 402-emit path.
    for (let i = 0; i < 10; i++) {
      const r = await app.request('/echo', { headers: ip });
      expect(r.status).toBe(200);
    }
  });
});
