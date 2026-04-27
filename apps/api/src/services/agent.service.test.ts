// Unit tests for agent.service.ts (VISION.md — agent launcher).
//
// Covers: preset validation, allowlist entry-type gating, parent-account
// resolution (cross-tenant safety), and the happy-path provisioning flow
// that threads through permission.service. Mocks @railforge/db and the
// permission service so this file stays in the unit layer (no rippled, no
// Redis, no real Postgres).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

interface InsertCall {
  table: string;
  values: unknown;
}

const dbInsertCalls: InsertCall[] = [];
const dbInsertResults: Record<string, unknown[]> = {
  accounts: [{ id: 'delegate-acct-1' }],
  agents: [{ id: 'agent-1' }],
  agent_allowlists: [],
  spend_policies: [],
};
// Side-channel: tests can set an error here to make the next insert/upsert
// for a given table throw (used to exercise the non-fatal spend-policy
// upsert branch in provisionAgent).
const dbInsertErrors: Record<string, Error> = {};
// FIFO queue for agent_allowlists results — `authorizeAgentPayment` calls
// `isAllowlisted` twice (destination, then token) through the SAME query
// chain. The queue lets a test return different rows per call, exercising
// the split case (destination hit, token miss) that a static row pool
// can't distinguish.
const dbAgentAllowlistsQueue: unknown[][] = [];
const dbSelectResults: Record<string, unknown[]> = {};
const dbUpdateCalls: unknown[] = [];

vi.mock('@railforge/db', () => {
  const buildInsertChain = (table: { __name: string }) => ({
    values: vi.fn((v: unknown) => {
      const terminal = {
        returning: vi.fn(async () => {
          dbInsertCalls.push({ table: table.__name, values: v });
          if (dbInsertErrors[table.__name]) throw dbInsertErrors[table.__name];
          return dbInsertResults[table.__name] ?? [];
        }),
        onConflictDoUpdate: vi.fn(async () => {
          dbInsertCalls.push({ table: table.__name, values: v });
          if (dbInsertErrors[table.__name]) throw dbInsertErrors[table.__name];
          return dbInsertResults[table.__name] ?? [];
        }),
      };
      // Also make the bare `.values(...)` awaitable for agent_allowlists bulk insert
      const awaitable = Object.assign(Promise.resolve([]), terminal);
      // capture the call even when awaited directly
      dbInsertCalls.push({ table: table.__name, values: v });
      return awaitable;
    }),
  });
  const insert = vi.fn((table: { __name: string }) => buildInsertChain(table));

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
        // authorizeAgentPayment joins agents → accounts. Route innerJoin
        // reads to a dedicated 'agents_joined' key so tests can seed the
        // joined-row shape (id, status, parentAccountId, parentAddress)
        // independently of the plain `accounts` lookup used by
        // resolveOwnedFundedAccount during provisioning.
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

  const update = vi.fn(() => ({
    set: vi.fn((vals: unknown) => ({
      where: vi.fn(async () => {
        dbUpdateCalls.push(vals);
        return [];
      }),
    })),
  }));

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({ insert, select });
  });

  return {
    db: { insert, select, update, transaction },
    schema: {
      accounts: { __name: 'accounts' },
      agents: { __name: 'agents' },
      agentAllowlists: { __name: 'agent_allowlists' },
      spendPolicies: { __name: 'spend_policies' },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
  };
});

// ── Permission service mock ─────────────────────────────────────────────────

const grantPermissionMock = vi.fn();
vi.mock('./permission.service.ts', () => ({
  grantPermission: (...args: unknown[]) => grantPermissionMock(...args),
  PermissionServiceError: class PermissionServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

// ── Logger mock ─────────────────────────────────────────────────────────────

vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Import AFTER mocks are registered.
import { authorizeAgentPayment, provisionAgent } from './agent.service.ts';

// ── Fixtures & helpers ──────────────────────────────────────────────────────

const CLIENT_ID = 'client-uuid-1';
const PARENT_ADDRESS = 'rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd'; // valid r-address shape
const OTHER_DESTINATION = 'rL4Km5aKxn7yQBFKTfZvKYvKnkQbJ8S7Zi';

function seedFundedParent() {
  dbSelectResults.accounts = [{ id: 'parent-acct-1', address: PARENT_ADDRESS, isFunded: true }];
}

function seedUnfundedParent() {
  dbSelectResults.accounts = [{ id: 'parent-acct-1', address: PARENT_ADDRESS, isFunded: false }];
}

function seedMissingParent() {
  dbSelectResults.accounts = [];
}

beforeEach(() => {
  dbInsertCalls.length = 0;
  dbUpdateCalls.length = 0;
  for (const key of Object.keys(dbSelectResults)) delete dbSelectResults[key];
  for (const key of Object.keys(dbInsertErrors)) delete dbInsertErrors[key];
  dbAgentAllowlistsQueue.length = 0;
  grantPermissionMock.mockReset();
  grantPermissionMock.mockResolvedValue({
    id: 'delegation-1',
    tx_id: 'grant-tx-1',
    delegator_address: PARENT_ADDRESS,
    delegate_address: 'rAGENT',
    permissions: ['Payment'],
    status: 'active',
    created_at: new Date(),
    revoked_at: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('provisionAgent — preset + validation', () => {
  it('rejects an unknown preset with invalid_preset', async () => {
    seedFundedParent();
    await expect(
      provisionAgent({
        clientId: CLIENT_ID,
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid
        preset: 'nonexistent-preset' as any,
        parentAddress: PARENT_ADDRESS,
        allowlist: [{ entry_type: 'destination', entry_value: OTHER_DESTINATION }],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'invalid_preset',
    });
  });

  it('rejects payment-agent without any allowlist entries', async () => {
    seedFundedParent();
    await expect(
      provisionAgent({
        clientId: CLIENT_ID,
        preset: 'payment-agent',
        parentAddress: PARENT_ADDRESS,
        allowlist: [],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'allowlist_required',
    });
  });

  it('rejects a domain allowlist entry for payment-agent (preset disallows it)', async () => {
    seedFundedParent();
    await expect(
      provisionAgent({
        clientId: CLIENT_ID,
        preset: 'payment-agent',
        parentAddress: PARENT_ADDRESS,
        allowlist: [
          {
            entry_type: 'domain',
            entry_value: 'a'.repeat(64),
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'invalid_allowlist',
    });
  });

  it('rejects a malformed destination entry', async () => {
    seedFundedParent();
    await expect(
      provisionAgent({
        clientId: CLIENT_ID,
        preset: 'payment-agent',
        parentAddress: PARENT_ADDRESS,
        allowlist: [{ entry_type: 'destination', entry_value: 'not-an-address' }],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'invalid_allowlist',
    });
  });

  it('accepts treasury-agent with an empty allowlist (not required)', async () => {
    seedFundedParent();
    const result = await provisionAgent({
      clientId: CLIENT_ID,
      preset: 'treasury-agent',
      parentAddress: PARENT_ADDRESS,
      allowlist: [],
    });
    expect(result.preset).toBe('treasury-agent');
    expect(result.allowlist).toEqual([]);
  });
});

describe('provisionAgent — parent-account resolution', () => {
  it('returns parent_not_found when the parent row does not exist for this client', async () => {
    seedMissingParent();
    await expect(
      provisionAgent({
        clientId: CLIENT_ID,
        preset: 'payment-agent',
        parentAddress: PARENT_ADDRESS,
        allowlist: [{ entry_type: 'destination', entry_value: OTHER_DESTINATION }],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'parent_not_found',
    });
  });

  it('returns parent_not_funded when the parent row exists but funding has not validated', async () => {
    seedUnfundedParent();
    await expect(
      provisionAgent({
        clientId: CLIENT_ID,
        preset: 'payment-agent',
        parentAddress: PARENT_ADDRESS,
        allowlist: [{ entry_type: 'destination', entry_value: OTHER_DESTINATION }],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'parent_not_funded',
    });
  });
});

describe('provisionAgent — happy path', () => {
  it('provisions: generates delegate, inserts agent row, calls grantPermission, returns seed once', async () => {
    seedFundedParent();

    const result = await provisionAgent({
      clientId: CLIENT_ID,
      preset: 'payment-agent',
      parentAddress: PARENT_ADDRESS,
      label: 'invoice-bot',
      allowlist: [{ entry_type: 'destination', entry_value: OTHER_DESTINATION }],
    });

    // Delegate seed returned in response
    expect(result.agent_seed).toMatch(/^s[a-zA-Z0-9]+$/);
    expect(result.agent_address).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
    expect(result.status).toBe('pending');
    expect(result.preset).toBe('payment-agent');
    expect(result.grant_tx_id).toBe('grant-tx-1');

    // Preset's default spend policy applied
    expect(result.spend_policy.max_xrp_per_tx_drops).toBe('10000000');
    expect(result.spend_policy.daily_xrp_limit_drops).toBe('100000000');

    // Permission service invoked with Payment permission
    expect(grantPermissionMock).toHaveBeenCalledTimes(1);
    const grantArg = grantPermissionMock.mock.calls[0]?.[0];
    expect(grantArg).toBeDefined();
    expect(grantArg.permissions).toEqual(['Payment']);
    expect(grantArg.delegatorAddress).toBe(PARENT_ADDRESS);

    // DB effects: accounts + agents + agent_allowlists + spend_policies touched
    const touchedTables = dbInsertCalls.map((c) => c.table);
    expect(touchedTables).toContain('accounts');
    expect(touchedTables).toContain('agents');
    expect(touchedTables).toContain('agent_allowlists');
    expect(touchedTables).toContain('spend_policies');

    // delegation_id backfill
    expect(
      dbUpdateCalls.some((u) => (u as { delegationId?: string }).delegationId === 'delegation-1'),
    ).toBe(true);
  });

  it('honors caller spend_policy overrides (including null to disable a default cap)', async () => {
    seedFundedParent();

    const result = await provisionAgent({
      clientId: CLIENT_ID,
      preset: 'payment-agent',
      parentAddress: PARENT_ADDRESS,
      allowlist: [{ entry_type: 'destination', entry_value: OTHER_DESTINATION }],
      spendPolicy: {
        maxXrpPerTxDrops: null, // disable per-tx cap the preset provides
        dailyXrpLimitDrops: '50000000', // tighten daily to 50 XRP
      },
    });

    expect(result.spend_policy.max_xrp_per_tx_drops).toBeNull();
    expect(result.spend_policy.daily_xrp_limit_drops).toBe('50000000');
  });

  // agent.service.ts:379-387 — the spend-policy upsert is wrapped in try/catch
  // and explicitly non-fatal: by the time we reach it, the agent row + signer
  // list are already in flight, so a failed policy upsert degrades to "no
  // daily cap" rather than orphaning the agent. This test pins that behavior.
  it('non-fatal: when spend-policy upsert throws, provisioning still completes', async () => {
    seedFundedParent();
    dbInsertErrors.spend_policies = new Error('connection reset by peer');

    const result = await provisionAgent({
      clientId: CLIENT_ID,
      preset: 'payment-agent',
      parentAddress: PARENT_ADDRESS,
      allowlist: [{ entry_type: 'destination', entry_value: OTHER_DESTINATION }],
    });

    expect(result.id).toBe('agent-1');
    expect(result.status).toBe('pending');
    expect(result.grant_tx_id).toBe('grant-tx-1');

    // Response surfaces the resolved policy values even though the row didn't
    // persist — better than hiding intent; ops alerts on the warn log are the
    // recovery channel.
    expect(result.spend_policy.max_xrp_per_tx_drops).toBe('10000000');
    expect(result.spend_policy.daily_xrp_limit_drops).toBe('100000000');

    // The upsert *was* attempted (so the failure is from the right call site,
    // not a missed branch above it).
    expect(dbInsertCalls.some((c) => c.table === 'spend_policies')).toBe(true);
  });
});

// ── authorizeAgentPayment ───────────────────────────────────────────────────
// VISION.md §"Enforcement path" — called from payment.service.sendPayment when
// the auth'd API key is bound to an agent. Must enforce: agent exists (cross-
// tenant), agent is active, source IS the parent, destination is on the
// allowlist, and (for non-XRP) the asset is on the allowlist.

const AGENT_ID = 'agent-uuid-1';
const PARENT_ACCT_ID = 'parent-acct-1';

function seedActiveAgent(overrides: { status?: string } = {}) {
  dbSelectResults.agents_joined = [
    {
      id: AGENT_ID,
      status: overrides.status ?? 'active',
      parentAccountId: PARENT_ACCT_ID,
      parentAddress: PARENT_ADDRESS,
    },
  ];
}

function seedAllowlistHit() {
  // Non-empty rows → isAllowlisted returns true on every call.
  dbSelectResults.agent_allowlists = [{ id: 'allow-1' }];
}

function seedAllowlistMiss() {
  dbSelectResults.agent_allowlists = [];
}

describe('authorizeAgentPayment', () => {
  it('rejects when the agent row is missing (or wrong tenant)', async () => {
    dbSelectResults.agents_joined = [];
    await expect(
      authorizeAgentPayment({
        clientId: CLIENT_ID,
        agentId: AGENT_ID,
        sourceAddress: PARENT_ADDRESS,
        destinationAddress: OTHER_DESTINATION,
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_found',
    });
  });

  it('rejects when the agent status is pending (not yet active on-ledger)', async () => {
    seedActiveAgent({ status: 'pending' });
    await expect(
      authorizeAgentPayment({
        clientId: CLIENT_ID,
        agentId: AGENT_ID,
        sourceAddress: PARENT_ADDRESS,
        destinationAddress: OTHER_DESTINATION,
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_active',
    });
  });

  it('rejects when the agent status is revoked', async () => {
    seedActiveAgent({ status: 'revoked' });
    await expect(
      authorizeAgentPayment({
        clientId: CLIENT_ID,
        agentId: AGENT_ID,
        sourceAddress: PARENT_ADDRESS,
        destinationAddress: OTHER_DESTINATION,
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_active',
    });
  });

  it("rejects when the payment source is not the agent's parent account", async () => {
    seedActiveAgent();
    seedAllowlistHit();
    await expect(
      authorizeAgentPayment({
        clientId: CLIENT_ID,
        agentId: AGENT_ID,
        sourceAddress: OTHER_DESTINATION, // not the parent
        destinationAddress: OTHER_DESTINATION,
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'source_not_parent',
    });
  });

  it("rejects when the destination is not on the agent's allowlist", async () => {
    seedActiveAgent();
    seedAllowlistMiss();
    await expect(
      authorizeAgentPayment({
        clientId: CLIENT_ID,
        agentId: AGENT_ID,
        sourceAddress: PARENT_ADDRESS,
        destinationAddress: OTHER_DESTINATION,
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'destination_not_allowlisted',
    });
  });

  it('accepts an XRP payment to an allowlisted destination (no assetKey check)', async () => {
    seedActiveAgent();
    seedAllowlistHit();
    await expect(
      authorizeAgentPayment({
        clientId: CLIENT_ID,
        agentId: AGENT_ID,
        sourceAddress: PARENT_ADDRESS,
        destinationAddress: OTHER_DESTINATION,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a non-XRP payment when both destination AND token are allowlisted', async () => {
    seedActiveAgent();
    seedAllowlistHit();
    await expect(
      authorizeAgentPayment({
        clientId: CLIENT_ID,
        agentId: AGENT_ID,
        sourceAddress: PARENT_ADDRESS,
        destinationAddress: OTHER_DESTINATION,
        assetKey: 'a'.repeat(48), // MPT issuance id shape
      }),
    ).resolves.toBeUndefined();
  });

  // Split-allowlist case: destination passes, token query returns empty.
  // The two `isAllowlisted` calls share the same query chain, so the
  // `dbAgentAllowlistsQueue` FIFO returns hit-then-miss to drive the path.
  it('rejects when destination is allowlisted but token is not', async () => {
    seedActiveAgent();
    dbAgentAllowlistsQueue.push([{ id: 'allow-dest' }], []);

    await expect(
      authorizeAgentPayment({
        clientId: CLIENT_ID,
        agentId: AGENT_ID,
        sourceAddress: PARENT_ADDRESS,
        destinationAddress: OTHER_DESTINATION,
        assetKey: 'a'.repeat(48),
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'token_not_allowlisted',
    });
  });
});
