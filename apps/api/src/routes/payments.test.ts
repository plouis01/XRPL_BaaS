// Route-level HTTP tests for /v1/payments (Sprint 7).

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const mockSendPayment = vi.fn();
const mockGetPayment = vi.fn();
const mockCreateEscrow = vi.fn();
const mockFinishEscrow = vi.fn();
const mockCancelEscrow = vi.fn();

vi.mock('../services/payment.service.ts', () => ({
  sendPayment: (...args: unknown[]) => mockSendPayment(...args),
  getPayment: (...args: unknown[]) => mockGetPayment(...args),
  createEscrow: (...args: unknown[]) => mockCreateEscrow(...args),
  finishEscrow: (...args: unknown[]) => mockFinishEscrow(...args),
  cancelEscrow: (...args: unknown[]) => mockCancelEscrow(...args),
  PaymentServiceError: class PaymentServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'PaymentServiceError';
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

const { default: paymentsRoute } = await import('./payments.ts');
const { PaymentServiceError } = await import('../services/payment.service.ts');

const VALID_SRC = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const VALID_DST = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    await next();
  });
  app.route('/payments', paymentsRoute);
  return app;
}

describe('POST /payments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('202 on XRP payment', async () => {
    mockSendPayment.mockResolvedValue({ txId: 'tx-1' });

    const app = makeApp();
    const res = await app.request('/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: VALID_SRC,
        destination: VALID_DST,
        amount_drops: '1000000',
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tx_id).toBe('tx-1');
    expect(body.status).toBe('queued');
  });

  it('202 on MPT payment', async () => {
    mockSendPayment.mockResolvedValue({ txId: 'tx-2' });

    const app = makeApp();
    const res = await app.request('/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: VALID_SRC,
        destination: VALID_DST,
        mpt_issuance_id: '00ABCDEF',
        value: '100',
      }),
    });

    expect(res.status).toBe(202);
  });

  it('400 when no amount group provided', async () => {
    const app = makeApp();
    const res = await app.request('/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: VALID_SRC, destination: VALID_DST }),
    });

    expect(res.status).toBe(400);
  });

  it('404 when source not found', async () => {
    mockSendPayment.mockRejectedValue(
      new PaymentServiceError('source_not_found', 'Source account not found'),
    );

    const app = makeApp();
    const res = await app.request('/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: VALID_SRC,
        destination: VALID_DST,
        amount_drops: '100',
      }),
    });

    expect(res.status).toBe(404);
  });
});

describe('GET /payments/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 with payment status', async () => {
    mockGetPayment.mockResolvedValue({
      id: 'tx-1',
      txType: 'Payment',
      sourceAddress: VALID_SRC,
      status: 'validated',
      resultCode: 'tesSUCCESS',
      txHash: 'DEADBEEF',
      ledgerIndex: 100,
      feeDrops: '12',
      createdAt: new Date('2026-01-01'),
      submittedAt: new Date('2026-01-01'),
      confirmedAt: new Date('2026-01-01'),
    });

    const app = makeApp();
    const res = await app.request('/payments/tx-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tx_hash).toBe('DEADBEEF');
    expect(body.source_address).toBe(VALID_SRC);
  });

  it('404 when payment not found', async () => {
    mockGetPayment.mockResolvedValue(null);

    const app = makeApp();
    const res = await app.request('/payments/tx-missing');

    expect(res.status).toBe(404);
  });
});

describe('POST /payments/escrows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('202 on success', async () => {
    mockCreateEscrow.mockResolvedValue({ txId: 'tx-esc' });

    const app = makeApp();
    const res = await app.request('/payments/escrows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: VALID_SRC,
        destination: VALID_DST,
        amount_drops: '5000000',
        finish_after: 900000000,
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tx_id).toBe('tx-esc');
  });

  it('400 when neither finish_after nor cancel_after is provided', async () => {
    const app = makeApp();
    const res = await app.request('/payments/escrows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: VALID_SRC,
        destination: VALID_DST,
        amount_drops: '5000000',
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /payments/batch', () => {
  it('501 not implemented', async () => {
    const app = makeApp();
    const res = await app.request('/payments/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(501);
  });
});
