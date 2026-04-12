// Route-level HTTP tests for /v1/dex (Sprint 7).

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const VALID_ADDR = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const VALID_ISSUER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

const mockCreateOffer = vi.fn();
const mockCancelOffer = vi.fn();
const mockAmmDeposit = vi.fn();
const mockAmmWithdraw = vi.fn();

vi.mock('../services/dex.service.ts', () => ({
  createOffer: (...args: unknown[]) => mockCreateOffer(...args),
  cancelOffer: (...args: unknown[]) => mockCancelOffer(...args),
  ammDeposit: (...args: unknown[]) => mockAmmDeposit(...args),
  ammWithdraw: (...args: unknown[]) => mockAmmWithdraw(...args),
  toAssetAmount: (a: Record<string, unknown>) => {
    if (a.drops !== undefined) return { drops: a.drops };
    if (a.mpt_issuance_id && a.value) return { mptIssuanceId: a.mpt_issuance_id, value: a.value };
    if (a.currency && a.issuer && a.value)
      return { currency: a.currency, issuer: a.issuer, value: a.value };
    throw new Error('bad asset');
  },
  toAssetCurrency: (a: Record<string, unknown>) => {
    if (a.drops) return { drops: '0' };
    if (a.mpt_issuance_id) return { mptIssuanceId: a.mpt_issuance_id };
    if (a.currency && a.issuer) return { currency: a.currency, issuer: a.issuer };
    throw new Error('bad currency');
  },
  DexServiceError: class DexServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'DexServiceError';
    }
  },
}));

vi.mock('../middleware/revocationCheck.ts', () => ({
  revocationCheck: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('@railforge/db', () => ({
  db: {},
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  schema: { apiKeys: {} },
}));

const { default: dexRoute } = await import('./dex.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    await next();
  });
  app.route('/dex', dexRoute);
  return app;
}

describe('POST /dex/offers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('202 on success', async () => {
    mockCreateOffer.mockResolvedValue({ tx_id: 'tx-1', status: 'queued' });
    const app = makeApp();
    const res = await app.request('/dex/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: VALID_ADDR,
        taker_gets: { drops: '1000000' },
        taker_pays: { currency: 'USD', issuer: VALID_ISSUER, value: '10' },
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tx_id).toBe('tx-1');
  });

  it('400 on invalid flags', async () => {
    const app = makeApp();
    const res = await app.request('/dex/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: VALID_ADDR,
        taker_gets: { drops: '1000000' },
        taker_pays: { currency: 'USD', issuer: VALID_ISSUER, value: '10' },
        flags: 999,
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /dex/offers/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('202 on success', async () => {
    mockCancelOffer.mockResolvedValue({ tx_id: 'tx-2', status: 'queued' });
    const app = makeApp();
    const res = await app.request('/dex/offers/42', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: VALID_ADDR, offer_sequence: 42 }),
    });
    expect(res.status).toBe(202);
  });

  it('400 when URL id mismatches body offer_sequence', async () => {
    const app = makeApp();
    const res = await app.request('/dex/offers/42', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: VALID_ADDR, offer_sequence: 99 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /dex/orderbook/:base/:counter', () => {
  it('501 not implemented', async () => {
    const app = makeApp();
    const res = await app.request('/dex/orderbook/XRP/USD');
    expect(res.status).toBe(501);
  });
});

describe('GET /dex/amm/:asset1/:asset2', () => {
  it('501 not implemented', async () => {
    const app = makeApp();
    const res = await app.request('/dex/amm/XRP/USD');
    expect(res.status).toBe(501);
  });
});
