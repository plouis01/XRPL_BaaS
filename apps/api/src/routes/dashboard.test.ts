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
      agentId: {},
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
      clientId: {},
      address: {},
      label: {},
      custodyMode: {},
      isFunded: {},
      metadata: {},
      createdAt: {},
    },
    agents: {
      __tableName: 'agents',
      id: {},
      clientId: {},
      parentAccountId: {},
      agentAddress: {},
      preset: {},
      label: {},
      status: {},
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

describe('GET /dashboard/transactions/:id', () => {
  const VALID_ID = '9af78f43-7f57-43fb-8d50-6c04300405e1';

  it('400 on malformed id', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/transactions/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('404 when the tx does not belong to this client', async () => {
    nextRows = []; // limit(1) returns no rows
    const app = makeApp();
    const res = await app.request(`/dashboard/transactions/${VALID_ID}`);
    expect(res.status).toBe(404);
  });

  it('200 with mapped row including result_code for a matching tx', async () => {
    nextRows = [
      {
        id: VALID_ID,
        txType: 'MPTokenAuthorize',
        sourceAddress: 'rHolder',
        status: 'failed',
        txHash: 'DEADBEEF',
        resultCode: 'tecDUPLICATE',
        ledgerIndex: 42,
        createdAt: new Date('2026-04-23'),
        confirmedAt: null,
      },
    ];
    const app = makeApp();
    const res = await app.request(`/dashboard/transactions/${VALID_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      result_code: string | null;
    };
    expect(body).toEqual(
      expect.objectContaining({
        id: VALID_ID,
        status: 'failed',
        result_code: 'tecDUPLICATE',
      }),
    );
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

describe('GET /dashboard/accounts', () => {
  it('400 when environment param missing', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/accounts');
    expect(res.status).toBe(400);
  });

  it('empty data when client has no key in selected env', async () => {
    nextKeyCheckRows = [];
    const app = makeApp();
    const res = await app.request('/dashboard/accounts?environment=mainnet');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('returns mapped account rows when client has a matching key', async () => {
    nextKeyCheckRows = [{ id: 'k1' }];
    nextRows = [
      {
        id: 'acct-1',
        address: 'rIssuerAddress',
        label: 'primary issuer',
        custodyMode: 'semi',
        isFunded: true,
        createdAt: new Date('2026-01-01'),
      },
    ];
    const app = makeApp();
    const res = await app.request('/dashboard/accounts?environment=testnet');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        address: string;
        is_funded: boolean;
        custody_mode: string;
      }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual(
      expect.objectContaining({
        id: 'acct-1',
        address: 'rIssuerAddress',
        is_funded: true,
        custody_mode: 'semi',
      }),
    );
  });

  // Discovered in browser-verify: agent-mode rows in `accounts` (those with
  // metadata.agent_of set) used to show up in the parent dropdown and could
  // be picked, leading to a stuck SignerListSet (rippled actNotFound).
  // The list endpoint must filter them out.
  it('filters out agent-mode rows (metadata.agent_of set)', async () => {
    nextKeyCheckRows = [{ id: 'k1' }];
    nextRows = [
      {
        id: 'acct-real-parent',
        address: 'rRealParent',
        label: 'parent',
        custodyMode: 'semi',
        isFunded: true,
        metadata: {},
        createdAt: new Date('2026-01-01'),
      },
      {
        id: 'acct-agent-as-parent',
        address: 'rAgentAddress',
        label: 'invoice-bot (agent)',
        custodyMode: 'semi',
        isFunded: true,
        metadata: { agent_of: 'rRealParent', preset: 'payment-agent' },
        createdAt: new Date('2026-01-02'),
      },
    ];
    const app = makeApp();
    const res = await app.request('/dashboard/accounts?environment=testnet');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; address: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.id).toBe('acct-real-parent');
    // The agent row was filtered out — its address must NOT appear.
    expect(body.data.find((r) => r.address === 'rAgentAddress')).toBeUndefined();
  });
});

describe('GET /dashboard/agents', () => {
  it('400 when environment param missing', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/agents');
    expect(res.status).toBe(400);
  });

  it('empty data when client has no key in selected env', async () => {
    nextKeyCheckRows = [];
    const app = makeApp();
    const res = await app.request('/dashboard/agents?environment=mainnet');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('returns mapped agent rows joined with parent address (no agent_seed leak)', async () => {
    nextKeyCheckRows = [{ id: 'k1' }];
    nextRows = [
      {
        id: 'agent-1',
        preset: 'payment-agent',
        parentAddress: 'rParentAddress',
        agentAddress: 'rAgentAddress',
        label: 'invoice-bot',
        status: 'active',
        createdAt: new Date('2026-04-27'),
      },
    ];
    const app = makeApp();
    const res = await app.request('/dashboard/agents?environment=testnet');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual(
      expect.objectContaining({
        id: 'agent-1',
        preset: 'payment-agent',
        parent_address: 'rParentAddress',
        agent_address: 'rAgentAddress',
        status: 'active',
      }),
    );
    // Critical: dashboard list never carries the seed.
    expect('agent_seed' in (body.data[0] ?? {})).toBe(false);
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

  // Agent-binding (Part 2 of the agent launcher follow-up). When the
  // POST body includes agent_id, the handler validates the agent exists,
  // belongs to the same client, and isn't revoked/failed; then threads
  // agent_id into the api_keys insert so the auth middleware can later
  // resolve the binding into c.get('agentId').
  const VALID_AGENT_ID = '11111111-2222-4333-8444-555555555555';

  it('binds agent_id when the agent exists and is not revoked', async () => {
    nextRows = [{ id: VALID_AGENT_ID, status: 'pending' }];
    nextInsertReturning = [
      {
        id: 'k-bound',
        prefix: 'rf_test_',
        environment: 'testnet',
        isActive: true,
        createdAt: new Date('2026-04-27'),
        agentId: VALID_AGENT_ID,
      },
    ];
    const app = makeApp();
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environment: 'testnet',
        agent_id: VALID_AGENT_ID,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    expect(body.agent_id).toBe(VALID_AGENT_ID);

    // The insert was called with the agent id threaded through.
    const keyRow = insertCalls.find((c) => c.table === 'api_keys');
    const vals = keyRow?.values as Record<string, unknown>;
    expect(vals.agentId).toBe(VALID_AGENT_ID);
  });

  it('404 when agent_id does not match an agent owned by the caller', async () => {
    nextRows = []; // no agent row
    const app = makeApp();
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environment: 'testnet',
        agent_id: VALID_AGENT_ID,
      }),
    });
    expect(res.status).toBe(404);
    expect(insertCalls.find((c) => c.table === 'api_keys')).toBeUndefined();
  });

  it("409 when agent_id resolves to an agent in status='revoked'", async () => {
    nextRows = [{ id: VALID_AGENT_ID, status: 'revoked' }];
    const app = makeApp();
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environment: 'testnet',
        agent_id: VALID_AGENT_ID,
      }),
    });
    expect(res.status).toBe(409);
    expect(insertCalls.find((c) => c.table === 'api_keys')).toBeUndefined();
  });

  it("409 when agent_id resolves to an agent in status='failed'", async () => {
    nextRows = [{ id: VALID_AGENT_ID, status: 'failed' }];
    const app = makeApp();
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environment: 'testnet',
        agent_id: VALID_AGENT_ID,
      }),
    });
    expect(res.status).toBe(409);
  });

  it('400 on malformed agent_id (not a UUID)', async () => {
    const app = makeApp();
    const res = await app.request('/dashboard/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environment: 'testnet',
        agent_id: 'not-a-uuid',
      }),
    });
    expect(res.status).toBe(400);
    expect(insertCalls.find((c) => c.table === 'api_keys')).toBeUndefined();
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
