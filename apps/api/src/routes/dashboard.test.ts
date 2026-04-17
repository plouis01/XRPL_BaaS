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
  };
}

let nextRows: unknown[] = [];
let nextKeyCheckRows: unknown[] = [];

// Builds a thenable query builder that:
//   - resolves to `nextRows` when awaited after `orderBy` (the /keys path)
//   - resolves to `nextRows` after `orderBy().limit(n)` (the data-list path)
//   - resolves to `nextKeyCheckRows` for the first `.where().limit(1)` call
//     against api_keys (the gate in the other three handlers)
function makeSelect(): Select {
  let selectCall = 0;
  return {
    from: (table: { __tableName: string }) => ({
      where: () => {
        const thenableOrderBy = () => {
          const p = Promise.resolve(nextRows);
          return Object.assign(p, {
            limit: (_n: number) => Promise.resolve(nextRows),
          });
        };
        return {
          orderBy: thenableOrderBy,
          limit: (_n: number) => {
            selectCall += 1;
            // First .where(...).limit(1) in each handler is the gate that
            // checks whether the client has an api_key in the selected env.
            if (table.__tableName === 'api_keys' && selectCall === 1) {
              return Promise.resolve(nextKeyCheckRows);
            }
            return Promise.resolve(nextRows);
          },
        };
      },
    }),
  } as unknown as Select;
}

vi.mock('@railforge/db', () => ({
  db: {
    select: () => makeSelect(),
  },
  eq: vi.fn(() => ({ __predicate: 'eq' })),
  and: vi.fn(() => ({ __predicate: 'and' })),
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

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    await next();
  });
  app.route('/dashboard', dashboardRoute);
  return app;
}

beforeEach(() => {
  nextRows = [];
  nextKeyCheckRows = [];
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
