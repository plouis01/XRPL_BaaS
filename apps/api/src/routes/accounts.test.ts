// Route-level HTTP tests for /v1/accounts (Sprint 7).
//
// These test the Hono route handlers end-to-end: request parsing, Zod
// validation, service delegation, error mapping, and response shape.
// Services and middleware are mocked so no DB or Redis is required.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

// ── Service mocks ───────────────────────────────────────────────────────────

const mockCreateAccount = vi.fn();
const mockGetAccount = vi.fn();
const mockConfigureSigners = vi.fn();
const mockRotateRegularKey = vi.fn();
const mockDeleteAccount = vi.fn();
const mockListCredentialsForAccount = vi.fn();

vi.mock('../services/account.service.ts', () => ({
  createAccount: (...args: unknown[]) => mockCreateAccount(...args),
  getAccount: (...args: unknown[]) => mockGetAccount(...args),
  configureSigners: (...args: unknown[]) => mockConfigureSigners(...args),
  rotateRegularKey: (...args: unknown[]) => mockRotateRegularKey(...args),
  deleteAccount: (...args: unknown[]) => mockDeleteAccount(...args),
  AccountServiceError: class AccountServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'AccountServiceError';
    }
  },
}));

vi.mock('../services/credential.service.ts', () => ({
  listCredentialsForAccount: (...args: unknown[]) => mockListCredentialsForAccount(...args),
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

const mockReadClientRequest = vi.fn();
vi.mock('../xrpl/readClient.ts', () => ({
  getReadClient: async () => ({ request: mockReadClientRequest }),
  __setReadClientForTests: vi.fn(),
}));

const { default: accountsRoute } = await import('./accounts.ts');
const { AccountServiceError } = await import('../services/account.service.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    await next();
  });
  app.route('/accounts', accountsRoute);
  return app;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('201 on success with snake_case response', async () => {
    mockCreateAccount.mockResolvedValue({
      id: 'acct-1',
      address: 'rNew000000000000000000000000000',
      regularKey: null,
      custodyMode: 'semi',
      label: 'test',
      isFunded: false,
      reserveBalance: '0',
      fundingTxId: 'tx-1',
      createdAt: new Date('2026-01-01'),
    });

    const app = makeApp();
    const res = await app.request('/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'test' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.address).toBe('rNew000000000000000000000000000');
    expect(body.is_funded).toBe(false);
    expect(body.funding_tx_id).toBe('tx-1');
    expect(body.custody_mode).toBe('semi');
  });

  it('503 when treasury not configured', async () => {
    mockCreateAccount.mockRejectedValue(
      new AccountServiceError('treasury_not_configured', 'no treasury'),
    );

    const app = makeApp();
    const res = await app.request('/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/unavailable/i);
  });

  it('409 on db_conflict', async () => {
    mockCreateAccount.mockRejectedValue(new AccountServiceError('db_conflict', 'collision'));

    const app = makeApp();
    const res = await app.request('/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
  });
});

describe('GET /accounts/:address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 with account data', async () => {
    mockGetAccount.mockResolvedValue({
      id: 'acct-1',
      address: 'rTest000000000000000000000000000',
      regularKey: null,
      custodyMode: 'semi',
      label: null,
      isFunded: true,
      reserveBalance: '20000000',
      fundingTxId: 'tx-1',
      createdAt: new Date('2026-01-01'),
    });

    const app = makeApp();
    const res = await app.request('/accounts/rTest000000000000000000000000000');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.is_funded).toBe(true);
    expect(body.reserve_balance).toBe('20000000');
  });

  it('404 when account not found', async () => {
    mockGetAccount.mockResolvedValue(null);

    const app = makeApp();
    const res = await app.request('/accounts/rUnknown');

    expect(res.status).toBe(404);
  });
});

describe('GET /accounts/:address/balances (PLAN.md §9.2 G-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 with xrp+trustlines+mpts from rippled', async () => {
    mockGetAccount.mockResolvedValue({ id: 'acct-1' });
    mockReadClientRequest
      .mockResolvedValueOnce({
        result: { account_data: { Balance: '9990000' } },
      })
      .mockResolvedValueOnce({
        result: {
          lines: [{ currency: 'USD', account: 'rIssuer', balance: '42' }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          account_objects: [{ MPTokenIssuanceID: 'AABB', MPTAmount: '100' }],
        },
      });

    const app = makeApp();
    const res = await app.request('/accounts/rAddr/balances');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: string;
      xrp_drops: string;
      trustlines: Array<{ currency: string; issuer: string; balance: string }>;
      mpts: Array<{ mpt_issuance_id: string; balance: string }>;
    };
    expect(body.xrp_drops).toBe('9990000');
    expect(body.trustlines).toEqual([{ currency: 'USD', issuer: 'rIssuer', balance: '42' }]);
    expect(body.mpts).toEqual([{ mpt_issuance_id: 'AABB', balance: '100' }]);
  });

  it("404 when the account isn't managed by the client", async () => {
    mockGetAccount.mockResolvedValue(null);

    const app = makeApp();
    const res = await app.request('/accounts/rAddr/balances');
    expect(res.status).toBe(404);
  });

  it('treats rippled actNotFound as zero XRP, empty lines/mpts', async () => {
    mockGetAccount.mockResolvedValue({ id: 'acct-1' });
    mockReadClientRequest.mockRejectedValue({
      data: { error: 'actNotFound' },
    });

    const app = makeApp();
    const res = await app.request('/accounts/rAddr/balances');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      xrp_drops: string;
      trustlines: unknown[];
      mpts: unknown[];
    };
    expect(body.xrp_drops).toBe('0');
    expect(body.trustlines).toEqual([]);
    expect(body.mpts).toEqual([]);
  });
});

describe('GET /accounts/:address/credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 with paginated credentials list (REVIEW.md H-4)', async () => {
    mockGetAccount.mockResolvedValue({ id: 'acct-1' });
    mockListCredentialsForAccount.mockResolvedValue({
      data: [{ id: 'cred-1', credentialType: 'AABB' }],
      has_more: false,
    });

    const app = makeApp();
    const res = await app.request('/accounts/rAddr/credentials');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.data).toHaveLength(1);
    expect(body.has_more).toBe(false);
  });

  it('400 on invalid limit query param', async () => {
    mockGetAccount.mockResolvedValue({ id: 'acct-1' });
    const app = makeApp();
    const res = await app.request('/accounts/rAddr/credentials?limit=0');
    expect(res.status).toBe(400);
  });

  it('400 on negative offset query param', async () => {
    mockGetAccount.mockResolvedValue({ id: 'acct-1' });
    const app = makeApp();
    const res = await app.request('/accounts/rAddr/credentials?offset=-1');
    expect(res.status).toBe(400);
  });

  it('threads limit+offset query params to the service', async () => {
    mockGetAccount.mockResolvedValue({ id: 'acct-1' });
    mockListCredentialsForAccount.mockResolvedValue({
      data: [],
      has_more: false,
    });

    const app = makeApp();
    await app.request('/accounts/rAddr/credentials?limit=25&offset=50');

    expect(mockListCredentialsForAccount).toHaveBeenCalledWith('client-1', 'rAddr', {
      limit: 25,
      offset: 50,
    });
  });

  it('404 when account not found', async () => {
    mockGetAccount.mockResolvedValue(null);

    const app = makeApp();
    const res = await app.request('/accounts/rUnknown/credentials');

    expect(res.status).toBe(404);
  });
});

describe('PUT /accounts/:address/signers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('202 on success', async () => {
    mockConfigureSigners.mockResolvedValue({ txId: 'tx-2' });

    const app = makeApp();
    const res = await app.request('/accounts/rAddr/signers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quorum: 2,
        signers: [
          { address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', weight: 1 },
          { address: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', weight: 1 },
        ],
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tx_id).toBe('tx-2');
    expect(body.status).toBe('queued');
  });

  it('404 when account not found', async () => {
    mockConfigureSigners.mockRejectedValue(
      new AccountServiceError('not_found', 'Account not found'),
    );

    const app = makeApp();
    const res = await app.request('/accounts/rAddr/signers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quorum: 2,
        signers: [{ address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', weight: 1 }],
      }),
    });

    expect(res.status).toBe(404);
  });

  it('400 on Zod validation failure (invalid address)', async () => {
    const app = makeApp();
    const res = await app.request('/accounts/rAddr/signers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quorum: 2,
        signers: [{ address: 'bad', weight: 1 }],
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /accounts/:address/rotate-key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('202 on success', async () => {
    mockRotateRegularKey.mockResolvedValue({ txId: 'tx-3' });

    const app = makeApp();
    const res = await app.request('/accounts/rAddr/rotate-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tx_id).toBe('tx-3');
  });
});

describe('DELETE /accounts/:address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('202 on success', async () => {
    mockDeleteAccount.mockResolvedValue({ txId: 'tx-4' });

    const app = makeApp();
    const res = await app.request('/accounts/rAddr', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6wTj',
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tx_id).toBe('tx-4');
  });

  it('400 on missing destination', async () => {
    const app = makeApp();
    const res = await app.request('/accounts/rAddr', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});
