// Route-level HTTP tests for /v1/x402 (Sprint 10 Day 4).
//
// Mounts only the x402 sub-app behind a tiny test-only auth shim that
// sets `clientId` on the Hono context — bypasses the real auth chain
// so each test exercises ONLY the route logic, not auth + rate-limit +
// idempotency + audit. The full middleware stack is verified in the
// idempotency / auth / etc. middleware tests already.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const PAYEE = 'rEHMTjmCNgxiGzgUTpV4Y1MwYpFpYz7e7p';
const TEST_INTENT_ID = 'x402_intent_ABCDEFGHJKMNPQRSTVWXYZ0123';
const TX_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// ── Service stubs ──────────────────────────────────────────────────────────

const stubs = {
  findIntent: vi.fn(),
  createRoute: vi.fn(),
  listRoutes: vi.fn(),
  deleteRoute: vi.fn(),
  verifyPayment: vi.fn(),
};

vi.mock('../services/x402Intent.service.ts', () => ({
  findIntent: (...a: unknown[]) => stubs.findIntent(...a),
  createRoute: (...a: unknown[]) => stubs.createRoute(...a),
  listRoutes: (...a: unknown[]) => stubs.listRoutes(...a),
  deleteRoute: (...a: unknown[]) => stubs.deleteRoute(...a),
}));

vi.mock('../services/x402Verify.service.ts', () => ({
  verifyPayment: (...a: unknown[]) => stubs.verifyPayment(...a),
}));

const { default: x402Route } = await import('./x402.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    await next();
  });
  app.route('/v1/x402', x402Route);
  return app;
}

const fakeIntent = (overrides: Record<string, unknown> = {}) => ({
  id: TEST_INTENT_ID,
  clientId: null,
  resourcePath: '/echo',
  payeeAddress: PAYEE,
  assetKind: 'xrp',
  assetKey: null,
  amount: '10000',
  destinationTag: 1234567,
  expiresAt: new Date('2026-12-31T00:00:00Z'),
  consumedAt: null,
  consumingTxHash: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const fakeRoute = (overrides: Record<string, unknown> = {}) => ({
  id: 'route-1',
  clientId: 'client-1',
  pathPattern: '/v1/x402-demo/echo',
  payeeAddress: PAYEE,
  assetKind: 'xrp',
  assetKey: null,
  priceAmount: '10000',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── POST /v1/x402/verify ───────────────────────────────────────────────────

describe('POST /v1/x402/verify', () => {
  it('returns 200 + ok:true on successful verification', async () => {
    stubs.verifyPayment.mockResolvedValueOnce({
      ok: true,
      intent: fakeIntent({
        consumedAt: new Date('2026-05-19T12:00:00Z'),
        consumingTxHash: TX_HASH,
      }),
      ledgerIndex: 99,
    });
    const res = await makeApp().request('/v1/x402/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent_id: TEST_INTENT_ID, tx_hash: TX_HASH }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      ledger_index: 99,
      intent_id: TEST_INTENT_ID,
      consumed_at: '2026-05-19T12:00:00.000Z',
    });
  });

  it('returns 200 + ok:false + reason on rejection', async () => {
    stubs.verifyPayment.mockResolvedValueOnce({
      ok: false,
      reason: 'amount_short',
    });
    const res = await makeApp().request('/v1/x402/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent_id: TEST_INTENT_ID, tx_hash: TX_HASH }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'amount_short' });
  });

  it('returns 400 on malformed intent id', async () => {
    const res = await makeApp().request('/v1/x402/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent_id: 'nope', tx_hash: TX_HASH }),
    });
    expect(res.status).toBe(400);
    expect(stubs.verifyPayment).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed tx hash', async () => {
    const res = await makeApp().request('/v1/x402/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent_id: TEST_INTENT_ID, tx_hash: 'short' }),
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /v1/x402/intents/:id ───────────────────────────────────────────────

describe('GET /v1/x402/intents/:id', () => {
  it('returns 404 when intent does not exist', async () => {
    stubs.findIntent.mockResolvedValueOnce(null);
    const res = await makeApp().request(`/v1/x402/intents/${TEST_INTENT_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns 200 with snake_case body for a Mode-B intent (clientId null)', async () => {
    stubs.findIntent.mockResolvedValueOnce(fakeIntent());
    const res = await makeApp().request(`/v1/x402/intents/${TEST_INTENT_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: TEST_INTENT_ID,
      resource_path: '/echo',
      payee_address: PAYEE,
      asset_kind: 'xrp',
      asset_key: null,
      amount: '10000',
      destination_tag: 1234567,
    });
  });

  it('returns 404 when intent belongs to a different client (cross-tenant guard)', async () => {
    stubs.findIntent.mockResolvedValueOnce(fakeIntent({ clientId: 'someone-else' }));
    const res = await makeApp().request(`/v1/x402/intents/${TEST_INTENT_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns 200 when intent belongs to the calling client', async () => {
    stubs.findIntent.mockResolvedValueOnce(fakeIntent({ clientId: 'client-1' }));
    const res = await makeApp().request(`/v1/x402/intents/${TEST_INTENT_ID}`);
    expect(res.status).toBe(200);
  });
});

// ── POST /v1/x402/routes ───────────────────────────────────────────────────

describe('POST /v1/x402/routes', () => {
  const validBody = {
    path_pattern: '/v1/x402-demo/echo',
    payee_address: PAYEE,
    asset: 'XRP',
    amount: '10000',
  };

  it('creates a route and returns 201', async () => {
    stubs.createRoute.mockResolvedValueOnce(fakeRoute());
    const res = await makeApp().request('/v1/x402/routes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'route-1',
      path_pattern: '/v1/x402-demo/echo',
      payee_address: PAYEE,
      asset_kind: 'xrp',
      price_amount: '10000',
      is_active: true,
    });
    expect(stubs.createRoute).toHaveBeenCalledWith({
      clientId: 'client-1',
      pathPattern: '/v1/x402-demo/echo',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '10000',
    });
  });

  it('returns 409 on duplicate (path_pattern) for the same client', async () => {
    const err = new Error('dup') as Error & { code?: string };
    err.code = '23505';
    stubs.createRoute.mockRejectedValueOnce(err);
    const res = await makeApp().request('/v1/x402/routes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(409);
  });

  it.each([
    ['no leading slash', { ...validBody, path_pattern: 'echo' }],
    ['contains query', { ...validBody, path_pattern: '/echo?foo=1' }],
    ['contains fragment', { ...validBody, path_pattern: '/echo#x' }],
    ['lowercase xrp', { ...validBody, asset: 'xrp' }],
    ['short mpt id', { ...validBody, asset: 'mpt:DEAD' }],
    ['amount=0', { ...validBody, amount: '0' }],
    ['amount with decimal', { ...validBody, amount: '1.5' }],
    ['bad payee', { ...validBody, payee_address: 'not-an-address' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await makeApp().request('/v1/x402/routes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(stubs.createRoute).not.toHaveBeenCalled();
  });

  it('accepts a valid mpt:<hex> asset reference', async () => {
    stubs.createRoute.mockResolvedValueOnce(
      fakeRoute({ assetKind: 'mpt', assetKey: 'A'.repeat(48) }),
    );
    const res = await makeApp().request('/v1/x402/routes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, asset: `mpt:${'a'.repeat(48)}` }),
    });
    expect(res.status).toBe(201);
  });
});

// ── GET /v1/x402/routes ────────────────────────────────────────────────────

describe('GET /v1/x402/routes', () => {
  it('returns an empty array when no routes registered', async () => {
    stubs.listRoutes.mockResolvedValueOnce([]);
    const res = await makeApp().request('/v1/x402/routes');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ routes: [] });
    expect(stubs.listRoutes).toHaveBeenCalledWith('client-1');
  });

  it('serialises routes with snake_case keys', async () => {
    stubs.listRoutes.mockResolvedValueOnce([fakeRoute(), fakeRoute({ id: 'route-2' })]);
    const res = await makeApp().request('/v1/x402/routes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      routes: Array<Record<string, unknown>>;
    };
    expect(body.routes).toHaveLength(2);
    expect(body.routes[0]).toHaveProperty('path_pattern');
    expect(body.routes[0]).toHaveProperty('price_amount');
  });
});

// ── DELETE /v1/x402/routes/:id ─────────────────────────────────────────────

describe('DELETE /v1/x402/routes/:id', () => {
  it('returns 204 on successful soft-delete', async () => {
    stubs.deleteRoute.mockResolvedValueOnce(true);
    const res = await makeApp().request('/v1/x402/routes/route-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(stubs.deleteRoute).toHaveBeenCalledWith('client-1', 'route-1');
  });

  it('returns 404 when route does not belong to the calling client', async () => {
    stubs.deleteRoute.mockResolvedValueOnce(false);
    const res = await makeApp().request('/v1/x402/routes/route-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});
