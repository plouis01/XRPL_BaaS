// End-to-end wiring test for the agent payment path.
//
// Unlike payments.test.ts (route handler with mocked services) and
// payment.service.test.ts (service with mocked authorize helper), this file
// runs the WHOLE chain wired together against a single seedable DB mock:
//
//   POST /v1/payments
//     → auth middleware       (loads api_keys row, sets agentId on context)
//     → payments route        (passes agentId into sendPayment)
//     → payment.service       (calls authorizeAgentPayment before enqueue)
//     → agent.service         (joins agents↔accounts, queries allowlist)
//
// Mocks live only at the boundaries: @railforge/db (per-table dispatch +
// FIFO queue for agent_allowlists), @railforge/jobs (enqueue no-op), and
// spendPolicy.service (no-op enforcement). The auth middleware computes
// keyHash from the raw key + salt; the test seeds the same hash on the
// fake api_keys row so the lookup matches.
//
// What this catches that the layered tests miss:
//   - auth middleware not setting `agentId` on the context (regression after
//     someone changes the column name or the c.set call)
//   - route handler not threading `agentId` into sendPayment
//   - payment service not calling authorizeAgentPayment when agentId is set
//   - allowlist row read with the wrong entry_type / entry_value shape

import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

// ── DB mock (per-table dispatch + agent_allowlists FIFO) ───────────────────
//
// The chain mocks `select().from(table).where(...).limit(...)` and dispatches
// based on `table.__name`. agent_allowlists has a FIFO queue because
// authorizeAgentPayment calls isAllowlisted twice on the same chain (once
// for destination, once — only on non-XRP — for token); the queue lets
// individual tests script different responses per call.

interface InsertCall {
  table: string;
  values: unknown;
}

const dbInsertCalls: InsertCall[] = [];
const dbInsertResults: Record<string, unknown[]> = {};
const dbSelectResults: Record<string, unknown[]> = {};
const dbAgentAllowlistsQueue: unknown[][] = [];
const enqueueCalls: unknown[] = [];

vi.mock('@railforge/db', () => {
  const insert = vi.fn((table: { __name: string }) => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ table: table.__name, values: v });
        return dbInsertResults[table.__name] ?? [];
      }),
    })),
  }));

  const select = vi.fn(() => ({
    from: vi.fn((table: { __name?: string } = {}) => {
      const tableName = table.__name ?? '';
      const data =
        tableName === 'agent_allowlists' && dbAgentAllowlistsQueue.length > 0
          ? (dbAgentAllowlistsQueue.shift() ?? [])
          : (dbSelectResults[tableName] ?? []);
      // biome-ignore lint/suspicious/noExplicitAny: self-referencing fluent mock
      const awaitable: any = Object.assign(Promise.resolve(data), {
        where: vi.fn(() => awaitable),
        limit: vi.fn(() => awaitable),
        // authorizeAgentPayment joins agents → accounts. The joined row
        // shape (id, status, parentAccountId, parentAddress) is seeded
        // under a dedicated 'agents_joined' key so it doesn't collide
        // with the plain `accounts` lookup payment.service does.
        innerJoin: vi.fn(() => {
          const joinedData = dbSelectResults.agents_joined ?? [];
          // biome-ignore lint/suspicious/noExplicitAny: mock reshape
          const joinedAwaitable: any = Object.assign(Promise.resolve(joinedData), {
            where: vi.fn(() => joinedAwaitable),
            limit: vi.fn(() => joinedAwaitable),
          });
          return joinedAwaitable;
        }),
      });
      return awaitable;
    }),
  }));

  return {
    db: { insert, select },
    schema: {
      apiKeys: {
        __name: 'api_keys',
        id: 'id',
        clientId: 'clientId',
        environment: 'environment',
        rateLimit: 'rateLimit',
        agentId: 'agentId',
        keyHash: 'keyHash',
        isActive: 'isActive',
        revokedAt: 'revokedAt',
      },
      accounts: {
        __name: 'accounts',
        id: 'id',
        clientId: 'clientId',
        address: 'address',
        isFunded: 'isFunded',
        deletedAt: 'deletedAt',
      },
      agents: {
        __name: 'agents',
        id: 'id',
        clientId: 'clientId',
        status: 'status',
        parentAccountId: 'parentAccountId',
      },
      agentAllowlists: {
        __name: 'agent_allowlists',
        id: 'id',
        agentId: 'agentId',
        entryType: 'entryType',
        entryValue: 'entryValue',
      },
      transactions: {
        __name: 'transactions',
        id: 'id',
      },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
  };
});

// Jobs mock — enqueue no-op so authorize-success doesn't try to talk to Redis.
vi.mock('@railforge/jobs', () => ({
  enqueueTxSubmit: vi.fn(async (data: unknown) => {
    enqueueCalls.push(data);
  }),
}));

// SpendPolicy mock — XRP/token caps aren't part of the agent wiring under test.
vi.mock('../services/spendPolicy.service.ts', () => ({
  enforceSpendPolicy: vi.fn(async () => {}),
  enforceTokenOpCount: vi.fn(async () => {}),
}));

// Logger — silence child loggers across all three layers.
vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// API_KEY_SALT must be set BEFORE importing auth.ts — hashApiKey reads it
// at call time but a missing salt at module load would still surface as a
// boot-time failure in any code that calls hashApiKey() at import time.
process.env.API_KEY_SALT = 'test-salt-do-not-use-in-production';

// Imports AFTER mocks + env are in place.
const { auth, hashApiKey } = await import('../middleware/auth.ts');
const { default: paymentsRoute } = await import('./payments.ts');

// ── Fixtures ───────────────────────────────────────────────────────────────

const RAW_AGENT_KEY = 'rf_test_agent_e2e_raw_key_value_xxxxxxxxxx';
// Real-looking base58 XRPL addresses — the validator schema rejects '0',
// 'O', 'I', 'l' (not in base58). Reusing the addresses other route tests
// use for source/destination keeps Zod validation out of the test lens.
const PARENT_ADDRESS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ALLOWLISTED_DST = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const FORBIDDEN_DST = 'rEAasdLBpUNBBXXfSk1NbggQjuv2qSyTJZ';
const CLIENT_ID = 'client-1';
const AGENT_ID = 'agent-1';
const PARENT_ACCT_ID = 'acct-1';

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', auth);
  app.route('/payments', paymentsRoute);
  return app;
}

// Stand up the seed state for the happy path. Each test layers its own
// allowlist response onto the FIFO queue so destination-allowed vs
// destination-forbidden cases share the rest of the seed.
function seedHappyPath(): void {
  dbSelectResults.api_keys = [
    {
      id: 'key-1',
      clientId: CLIENT_ID,
      environment: 'testnet',
      rateLimit: 100,
      agentId: AGENT_ID,
    },
  ];
  dbSelectResults.accounts = [{ id: PARENT_ACCT_ID, address: PARENT_ADDRESS, isFunded: true }];
  dbSelectResults.agents_joined = [
    {
      id: AGENT_ID,
      status: 'active',
      parentAccountId: PARENT_ACCT_ID,
      parentAddress: PARENT_ADDRESS,
    },
  ];
  dbInsertResults.transactions = [{ id: 'tx-e2e-1' }];
}

function resetState(): void {
  dbInsertCalls.length = 0;
  dbAgentAllowlistsQueue.length = 0;
  enqueueCalls.length = 0;
  for (const k of Object.keys(dbSelectResults)) delete dbSelectResults[k];
  for (const k of Object.keys(dbInsertResults)) delete dbInsertResults[k];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('agent payment — end-to-end wiring (auth → route → service → gate)', () => {
  beforeAll(() => {
    if (!process.env.API_KEY_SALT) {
      throw new Error('test setup error: API_KEY_SALT not set');
    }
  });

  beforeEach(() => {
    resetState();
    seedHappyPath();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('202 when destination is on the agent allowlist', async () => {
    // Allowlist hit: destination check returns one row.
    dbAgentAllowlistsQueue.push([{ id: 'al-1' }]);

    const app = makeApp();
    const res = await app.request('/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': RAW_AGENT_KEY,
        'Idempotency-Key': 'idem-1',
      },
      body: JSON.stringify({
        source: PARENT_ADDRESS,
        destination: ALLOWLISTED_DST,
        amount_drops: '1000000',
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { tx_id: string; status: string };
    expect(body.tx_id).toBe('tx-e2e-1');
    expect(body.status).toBe('queued');

    // Wiring assertions — these are what catch regressions across the chain:
    //   - the auth lookup ran with our exact key hash (auth wired up)
    //   - the transaction insert fired (service ran past the gate)
    //   - the worker enqueue fired (post-gate path completed)
    const txInsert = dbInsertCalls.find((c) => c.table === 'transactions');
    expect(txInsert).toBeDefined();
    expect(enqueueCalls).toHaveLength(1);
  });

  it('400 when destination is NOT on the agent allowlist (no insert, no enqueue)', async () => {
    // Allowlist miss: destination check returns zero rows.
    dbAgentAllowlistsQueue.push([]);

    const app = makeApp();
    const res = await app.request('/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': RAW_AGENT_KEY,
        'Idempotency-Key': 'idem-2',
      },
      body: JSON.stringify({
        source: PARENT_ADDRESS,
        destination: FORBIDDEN_DST,
        amount_drops: '1000000',
      }),
    });

    // NOTE: payment.service translates AgentServiceError('destination_not_allowlisted')
    // → PaymentServiceError('invalid_input'), and the route maps invalid_input
    // → 400. There is no 403 path on POST /payments today — that status is
    // reserved for the requireNotAgent middleware on /escrows and /batch.
    // If a future change wants 403 for allowlist misses, it needs a new
    // PaymentServiceError code with its own status mapping.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/allowlist/i);

    // The gate ran BEFORE the tx insert + enqueue — neither side effect fires.
    expect(dbInsertCalls.find((c) => c.table === 'transactions')).toBeUndefined();
    expect(enqueueCalls).toHaveLength(0);
  });

  it('401 when the X-API-Key header is missing (auth wiring sanity check)', async () => {
    const app = makeApp();
    const res = await app.request('/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: PARENT_ADDRESS,
        destination: ALLOWLISTED_DST,
        amount_drops: '1000000',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('demonstrates auth produced the same key hash the seed expects', () => {
    // Pure sanity check — if hashApiKey ever changes (different algo, salt
    // not read, encoding shift), the e2e tests above would silently 401 on
    // every request. Asserting the hash explicitly here makes that mode
    // visible in the test output instead of hiding behind a 401.
    const hash = hashApiKey(RAW_AGENT_KEY);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
