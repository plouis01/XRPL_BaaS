// Route-level HTTP tests for /v1/tokens (Sprint 7).

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const VALID_ADDR = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const VALID_HOLDER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

const mockCreateToken = vi.fn();
const mockTransferToken = vi.fn();
const mockFreezeToken = vi.fn();
const mockClawbackToken = vi.fn();

vi.mock('../services/token.service.ts', () => ({
  createToken: (...args: unknown[]) => mockCreateToken(...args),
  transferToken: (...args: unknown[]) => mockTransferToken(...args),
  freezeToken: (...args: unknown[]) => mockFreezeToken(...args),
  clawbackToken: (...args: unknown[]) => mockClawbackToken(...args),
  TokenServiceError: class TokenServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'TokenServiceError';
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

const { default: tokensRoute } = await import('./tokens.ts');
const { TokenServiceError } = await import('../services/token.service.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    await next();
  });
  app.route('/tokens', tokensRoute);
  return app;
}

describe('POST /tokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('202 on success', async () => {
    mockCreateToken.mockResolvedValue({
      id: 'tok-1',
      issuerAddress: VALID_ADDR,
      tokenType: 'mpt',
      currencyCode: 'USD',
      mptIssuanceId: '00AA',
      transferFee: 0,
      clawback: true,
      freezeEnabled: true,
      maxSupply: null,
      status: 'queued',
      txId: 'tx-1',
      createdAt: new Date(),
    });

    const app = makeApp();
    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issuer: VALID_ADDR, currency_code: 'USD' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token_type).toBe('mpt');
    expect(body.tx_id).toBe('tx-1');
  });

  it('404 when issuer not found', async () => {
    mockCreateToken.mockRejectedValue(new TokenServiceError('issuer_not_found', 'not found'));
    const app = makeApp();
    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issuer: VALID_ADDR, currency_code: 'USD' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /tokens/:id/transfer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('202 on success', async () => {
    mockTransferToken.mockResolvedValue({ txId: 'tx-2' });
    const app = makeApp();
    const res = await app.request('/tokens/tok-1/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: VALID_HOLDER, amount: '100' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tx_id).toBe('tx-2');
  });
});

describe('PUT /tokens/:id/clawback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('202 on success', async () => {
    mockClawbackToken.mockResolvedValue({ txId: 'tx-3' });
    const app = makeApp();
    const res = await app.request('/tokens/tok-1/clawback', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holder: VALID_HOLDER, amount: '50' }),
    });
    expect(res.status).toBe(202);
  });
});
