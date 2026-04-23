// Route-level HTTP tests for /v1/dashboard — the backend wiring for the
// dashboard's network selector. Verifies:
//   1. Missing/invalid network param → 400
//   2. When the authenticated client has no api_key in the selected env,
//      every list endpoint returns `data: []` (sandbox toggle UX)
//   3. When the env matches, rows are returned scoped to the client
//   4. /keys filters by environment directly, not via the coarse gate

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

// ── Drizzle fake ──
// A stateful fake `db` that records the last `where(...)` target and
// returns whatever rows we've queued. Enough to exercise the query
// shape without a real Postgres.
interface Select {
  from: (table: { __tableName: string }) => {
    where: (predicate: { __predicate: unknown }) => {
      limit?: (n: number) => Promise<unknown[]>;
      orderBy: (_o: unknown) => {
        limit: (n: number) => Promise<unknown[]>;
      };
    };
    // `innerJoin(...)` chains into the same where/orderBy/limit shape. The
    // dashboard /tokens route uses it to surface issuer classic addresses.
    innerJoin: (
      _table: unknown,
      _on: unknown,
    ) => {
      where: (predicate: { __predicate: unknown }) => {
        orderBy: (_o: unknown) => { limit: (n: number) => Promise<unknown[]> };
      };
    };
  };
}

let nextRows: unknown[] = [];
let nextKeyCheckRows: unknown[] = [];

// Per-request counter for api_keys `.limit(1)` queries. The first call
// in every request comes from revocationCheck middleware (REVIEW.md LOW-07);
// it must see an active key so the handler runs. Subsequent calls come from
// clientHasKeyInEnvironment — those get `nextKeyCheckRows`, the knob the
// test-case uses to flip between "client has an env key" and "no env key".
let apiKeysCallCount = 0;

// Builds a thenable query builder that:
//   - resolves to `nextRows` when awaited after `orderBy` (the /keys path)
//   - resolves to `nextRows` after `orderBy().limit(n)` (the data-list path)
//   - resolves to a synthetic "active key" row on the FIRST api_keys .limit(1)
//     call each request (the revocationCheck probe)
//   - resolves to `nextKeyCheckRows` for every SUBSEQUENT api_keys .limit(1)
//     call (the env gate in the read handlers)
function makeSelect(): Select {
  const thenableOrderBy = () => {
    const p = Promise.resolve(nextRows);
    return Object.assign(p, {
      limit: (_n: number) => Promise.resolve(nextRows),
    });
  };
  return {
    from: (table: { __tableName: string }) => ({
      where: () => {
        return {
          orderBy: thenableOrderBy,
          limit: (_n: number) => {
            if (table.__tableName === 'api_keys') {
              apiKeysCallCount += 1;
              if (apiKeysCallCount === 1) {
                return Promise.resolve([{ id: 'key-1' }]);
              }
              return Promise.resolve(nextKeyCheckRows);
            }
            return Promise.resolve(nextRows);
          },
        };
      },
      innerJoin: (_t: unknown, _on: unknown) => ({
        where: () => ({ orderBy: thenableOrderBy }),
      }),
    }),
  } as unknown as Select;
}

let nextInsertReturning: unknown[] = [];
let nextUpdateReturning: unknown[] = [];
const insertCalls: Array<{ table: string; values: unknown }> = [];

vi.mock('@railforge/db', () => ({
  db: {
    select: () => makeSelect(),
    insert: (table: { __tableName: string }) => ({
      values(v: unknown) {
        insertCalls.push({ table: table.__tableName, values: v });
        return {
          returning: () => Promise.resolve(nextInsertReturning),
        };
      },
    }),
    update: (_table: { __tableName: string }) => ({
      set(_v: unknown) {
        return {
          where(_p: unknown) {
            return { returning: () => Promise.resolve(nextUpdateReturning) };
          },
        };
      },
    }),
  },
  eq: vi.fn(() => ({ __predicate: 'eq' })),
  and: vi.fn(() => ({ __predicate: 'and' })),
  // isNull is imported by revocationCheck (mounted on the dashboard router
  // per REVIEW.md LOW-07). Without this the module crashes at request time
  // and every test returns 503 instead of the expected status.
  isNull: vi.fn(() => ({ __predicate: 'isNull' })),
  desc: vi.fn((_col: unknown) => ({ __order: 'desc' })),
  schema: {
    apiKeys: {
      __tableName: 'api_keys',
      id: {},
      clientId: {},
      environment: {},
      keyPrefix: {},
      isActive: {},
      createdAt: {},
      revokedAt: {},
    },
    transactions: {
      __tableName: 'transactions',
      id: {},
      clientId: {},
      txType: {},
      sourceAddress: {},
      status: {},
      txHash: {},
      resultCode: {},
      ledgerIndex: {},
      createdAt: {},
      confirmedAt: {},
    },
    credentials: {
      __tableName: 'credentials',
      id: {},
      clientId: {},
      issuerAddress: {},
      subjectAddress: {},
      credentialType: {},
      status: {},
      expiresAt: {},
      acceptedAt: {},
      createdAt: {},
    },
    tokens: {
      __tableName: 'tokens',
      id: {},
      clientId: {},
      issuerAccount: {},
      tokenType: {},
      currencyCode: {},
      mptIssuanceId: {},
      transferFee: {},
      clawback: {},
      freezeEnabled: {},
      maxSupply: {},
      createdAt: {},
    },
    accounts: {
      __tableName: 'accounts',
      id: {},
      address: {},
    },
    domains: {
      __tableName: 'domains',
      id: {},
      clientId: {},
      ownerAddress: {},
      domainId: {},
      acceptedCredentials: {},
      createdAt: {},
      updatedAt: {},
    },
  },
}));

const { default: dashboardRoute } = await import('./dashboard.ts');

function makeApp(callerEnv: 'testnet' | 'mainnet' = 'testnet'): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', callerEnv);
    await next();
  });
  app.route('/dashboard', dashboardRoute);
  return app;
}

beforeEach(() => {
  nextRows = [];
  nextKeyCheckRows = [];
  nextInsertReturning = [];
  nextUpdateReturning = [];
  insertCalls.length = 0;
  apiKeysCallCount = 0;
  // The hashApiKey helper reads API_KEY_SALT at call time; set a fake so
  // the create-key test doesn't hit the production-guard throw.
  process.env.API_KEY_SALT = 'test-salt';
});

describe('GET /dashboard/transactions', () => {
  it('400 when network param missing', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/transactions');
    expect(res.status).toBe(400);
  });

  it('400 on invalid network value', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/transactions?network=devnet');
    expect(res.status).toBe(400);
  });

  it('400 on out-of-range limit', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/transactions?network=testnet&limit=500');
    expect(res.status).toBe(400);
  });

  it('empty data when client has no key in selected network', async () => {
    nextKeyCheckRows = []; // no matching key
    const app = makeApp();
    const res = await app.request('/dashboard/transactions?network=mainnet');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('returns mapped rows when client has a matching key', async () => {
    nextKeyCheckRows = [{ id: 'k1' }];
    nextRows = [
      {
        id: 't1',
        txType: 'Payment',
        sourceAddress: 'rSrc',
        status: 'validated',
        txHash: 'DEAD',
        resultCode: 'tesSUCCESS',
        ledgerIndex: 100,
        createdAt: new Date('2026-01-01'),
        confirmedAt: new Date('2026-01-01'),
      },
    ];
    const app = makeApp();
    const res = await app.request('/dashboard/transactions?network=testnet');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ tx_type: string; source_address: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.tx_type).toBe('Payment');
    expect(body.data[0]?.source_address).toBe('rSrc');
  });
});

describe('GET /dashboard/credentials', () => {
  it('400 when environment param missing', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/credentials');
    expect(res.status).toBe(400);
  });

  it('empty data when no key matches', async () => {
    nextKeyCheckRows = [];
    const app = makeApp();
    const res = await app.request('/dashboard/credentials?environment=mainnet');
    const body = (await res.json()) as { data: unknown[] };
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });
});

describe('GET /dashboard/domains', () => {
  it('400 when environment param missing', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/domains');
    expect(res.status).toBe(400);
  });
});

describe('GET /dashboard/tokens', () => {
  it('400 when environment param missing', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/tokens');
    expect(res.status).toBe(400);
  });

  it('empty data when client has no key in selected env', async () => {
    nextKeyCheckRows = [];
    const app = makeApp();
    const res = await app.request('/dashboard/tokens?environment=mainnet');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('maps rows with issuer classic address from the join', async () => {
    nextKeyCheckRows = [{ id: 'k1' }];
    nextRows = [
      {
        id: 'tok-1',
        issuerAddress: 'rIssuerClassic',
        tokenType: 'mpt',
        currencyCode: 'USDC',
        mptIssuanceId: 'DEADBEEF',
        transferFee: 0,
        clawback: true,
        freezeEnabled: true,
        maxSupply: null,
        createdAt: new Date('2026-01-01'),
      },
    ];
    const app = makeApp();
    const res = await app.request('/dashboard/tokens?environment=testnet');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        issuer_address: string;
        token_type: string;
        mpt_issuance_id: string | null;
      }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual(
      expect.objectContaining({
        id: 'tok-1',
        issuer_address: 'rIssuerClassic',
        token_type: 'mpt',
        mpt_issuance_id: 'DEADBEEF',
      }),
    );
  });
});

describe('GET /dashboard/keys', () => {
  it('400 when environment param missing', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/keys');
    expect(res.status).toBe(400);
  });

  it('200 with keys filtered by environment (direct filter, no gate)', async () => {
    nextRows = [
      {
        id: 'k1',
        prefix: 'rf_test_',
        environment: 'testnet',
        isActive: true,
        createdAt: new Date('2026-01-01'),
        revokedAt: null,
      },
    ];
    const app = makeApp();
    const res = await app.request('/dashboard/keys?environment=testnet');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ prefix: string; environment: string; is_active: boolean }>;
    };
    expect(body.data[0]?.prefix).toBe('rf_test_');
    expect(body.data[0]?.environment).toBe('testnet');
    expect(body.data[0]?.is_active).toBe(true);
  });
});

describe('POST /dashboard/keys', () => {
  it('201 returns the raw key once, persists a hash, never the key itself', async () => {
    nextInsertReturning = [
      {
        id: 'k-new',
        prefix: 'rf_test_',
        environment: 'testnet',
        isActive: true,
        createdAt: new Date('2026-01-01'),
      },
    ];
    const app = makeApp();
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environment: 'testnet', label: 'dev laptop' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      key: string;
      prefix: string;
      environment: string;
    };
    expect(body.id).toBe('k-new');
    expect(body.environment).toBe('testnet');
    expect(body.key).toMatch(/^rf_test_/);

    // The raw key must never have been written to storage.
    const keyRow = insertCalls.find((c) => c.table === 'api_keys');
    expect(keyRow).toBeDefined();
    const vals = keyRow?.values as Record<string, unknown>;
    expect(vals.keyHash).not.toBe(body.key); // stored as hash, not plaintext
    expect(typeof vals.keyHash).toBe('string');
    expect((vals.keyHash as string).length).toBe(64); // hex-encoded SHA-256
  });

  it('uses live prefix for mainnet keys (mainnet-scoped caller)', async () => {
    nextInsertReturning = [
      {
        id: 'k-live',
        prefix: 'rf_live_',
        environment: 'mainnet',
        isActive: true,
        createdAt: new Date('2026-01-01'),
      },
    ];
    const app = makeApp('mainnet');
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environment: 'mainnet' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string };
    expect(body.key).toMatch(/^rf_live_/);
  });

  it('HIGH-02: refuses to mint a mainnet key from a testnet-scoped caller', async () => {
    const app = makeApp('testnet');
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environment: 'mainnet' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Forbidden');
    // Crucially — no insert happened.
    expect(insertCalls.find((c) => c.table === 'api_keys')).toBeUndefined();
  });

  it('HIGH-02: refuses to mint a testnet key from a mainnet-scoped caller', async () => {
    const app = makeApp('mainnet');
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environment: 'testnet' }),
    });
    expect(res.status).toBe(403);
    expect(insertCalls.find((c) => c.table === 'api_keys')).toBeUndefined();
  });

  it('400 on invalid environment', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environment: 'devnet' }),
    });
    expect(res.status).toBe(400);
  });

  it('400 on missing body', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /dashboard/keys/:id/revoke', () => {
  it('200 when the key belongs to the client', async () => {
    nextUpdateReturning = [{ id: 'k-1' }];
    const app = makeApp();
    const res = await app.request('/dashboard/keys/k-1/revoke', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);
  });

  it("404 when the key doesn't exist or belongs to another tenant", async () => {
    nextUpdateReturning = [];
    const app = makeApp();
    const res = await app.request('/dashboard/keys/k-other/revoke', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});
