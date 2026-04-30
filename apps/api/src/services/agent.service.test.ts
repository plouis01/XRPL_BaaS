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
// for a given table throw (used to exercise the fatal spend-policy upsert
// branch in provisionAgent — failure inside the tx must roll back the
// whole provision before grantPermission runs).
const dbInsertErrors: Record<string, Error> = {};
// FIFO queue for agent_allowlists results — `authorizeAgentPayment` calls
// `isAllowlisted` twice (destination, then token) through the SAME query
// chain. The queue lets a test return different rows per call, exercising
// the split case (destination hit, token miss) that a static row pool
// can't distinguish.
const dbAgentAllowlistsQueue: unknown[][] = [];
const dbSelectResults: Record<string, unknown[]> = {};
const dbUpdateCalls: unknown[] = [];
// updateAgentAllowlist runs a delete-then-insert transaction; tests assert
// against these to verify the wipe ran before the new rows were inserted.
const dbDeleteCalls: Array<{ table: string }> = [];
const dbDeleteErrors: Record<string, Error> = {};
let dbTransactionError: Error | null = null;

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

  // updateAgentAllowlist deletes the existing rows inside a transaction
  // before inserting the new set. The mock captures each delete by table
  // so tests can assert the agent_allowlists wipe ran.
  const _delete = vi.fn((table: { __name: string }) => ({
    where: vi.fn(async () => {
      dbDeleteCalls.push({ table: table.__name });
      if (dbDeleteErrors[table.__name]) throw dbDeleteErrors[table.__name];
      return [];
    }),
  }));

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    if (dbTransactionError) throw dbTransactionError;
    return cb({ insert, select, delete: _delete });
  });

  return {
    db: { insert, select, update, transaction, delete: _delete },
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
const revokePermissionMock = vi.fn();
vi.mock('./permission.service.ts', () => ({
  grantPermission: (...args: unknown[]) => grantPermissionMock(...args),
  revokePermission: (...args: unknown[]) => revokePermissionMock(...args),
  PermissionServiceError: class PermissionServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

// agent.service imports invalidateSpendPolicyCache from spendPolicy.service.ts
// which boots a Redis client at module load. Stub it out — the cache-clear
// is best-effort and not load-bearing for the service-level tests.
const invalidateSpendPolicyCacheMock = vi.fn();
vi.mock('./spendPolicy.service.ts', () => ({
  invalidateSpendPolicyCache: (...args: unknown[]) => invalidateSpendPolicyCacheMock(...args),
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
import {
  authorizeAgentPayment,
  getAgent,
  listAgents,
  provisionAgent,
  revokeAgent,
  updateAgentAllowlist,
  updateAgentSpendPolicy,
} from './agent.service.ts';
// Bring in the mocked PermissionServiceError class so revokeAgent's
// `instanceof` check matches values constructed from the test side.
import { PermissionServiceError as MockedPermissionServiceError } from './permission.service.ts';

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

function seedAgentModeParent() {
  // Mirrors the metadata shape provisionAgent itself writes (line 296):
  //   metadata: { agent_of: parent.address, preset: input.preset }
  // Picking such a row as a parent must be rejected — the address is
  // not a funded ledger account on its own, and a SignerListSet from
  // it would fail at rippled with actNotFound.
  dbSelectResults.accounts = [
    {
      id: 'agent-as-parent-acct',
      address: PARENT_ADDRESS,
      isFunded: true,
      metadata: { agent_of: 'rOtherParentAddr', preset: 'payment-agent' },
    },
  ];
}

beforeEach(() => {
  dbInsertCalls.length = 0;
  dbUpdateCalls.length = 0;
  dbDeleteCalls.length = 0;
  dbTransactionError = null;
  for (const key of Object.keys(dbSelectResults)) delete dbSelectResults[key];
  for (const key of Object.keys(dbInsertErrors)) delete dbInsertErrors[key];
  for (const key of Object.keys(dbDeleteErrors)) delete dbDeleteErrors[key];
  dbAgentAllowlistsQueue.length = 0;
  grantPermissionMock.mockReset();
  revokePermissionMock.mockReset();
  invalidateSpendPolicyCacheMock.mockReset();
  revokePermissionMock.mockResolvedValue({ tx_id: 'revoke-tx-1' });
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

  // Discovered in browser-verify after the revoke flow: an agent row in
  // accounts (custody_mode='semi', metadata.agent_of=<parent>) used to
  // appear in the parent dropdown and could be picked as a parent. Submit
  // then stuck at 'submitting' on rippled (actNotFound — agent address has
  // no on-ledger entry of its own). Service must reject before queuing.
  it('rejects when the picked parent is itself an agent (metadata.agent_of set)', async () => {
    seedAgentModeParent();
    await expect(
      provisionAgent({
        clientId: CLIENT_ID,
        preset: 'payment-agent',
        parentAddress: PARENT_ADDRESS,
        allowlist: [{ entry_type: 'destination', entry_value: OTHER_DESTINATION }],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'parent_is_agent',
    });
    // Critical: nothing was inserted into accounts/agents and grantPermission
    // never ran — no on-ledger artifacts on the failure path.
    expect(grantPermissionMock).not.toHaveBeenCalled();
    expect(dbInsertCalls.find((c) => c.table === 'accounts')).toBeUndefined();
    expect(dbInsertCalls.find((c) => c.table === 'agents')).toBeUndefined();
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
    // REVIEW D3: provisionAgent must hand grantPermission its agentId so
    // the delegation_id back-fill happens INSIDE grantPermission's
    // transaction. The previous bare post-call UPDATE could leave the
    // agents row stranded with delegation_id=NULL on a transient failure.
    // The mock returns 'agent-1' as the inserted agents.id; assert it
    // gets threaded through to the grant call.
    expect(grantArg.agentId).toBe('agent-1');

    // DB effects: accounts + agents + agent_allowlists + spend_policies touched
    const touchedTables = dbInsertCalls.map((c) => c.table);
    expect(touchedTables).toContain('accounts');
    expect(touchedTables).toContain('agents');
    expect(touchedTables).toContain('agent_allowlists');
    expect(touchedTables).toContain('spend_policies');
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

  // Spend-policy upsert is FATAL and runs inside the same transaction as the
  // agents/accounts inserts. Previously this was wrapped in try/catch and
  // non-fatal — that left a window where the agent flipped to 'active' on-
  // ledger with no daily XRP cap (security regression). Failing fatally
  // before grantPermission queues any on-ledger work means a policy-insert
  // failure leaves nothing in flight on retry.
  it('fatal: spend-policy upsert failure aborts provisioning before grantPermission runs', async () => {
    seedFundedParent();
    dbInsertErrors.spend_policies = new Error('connection reset by peer');

    await expect(
      provisionAgent({
        clientId: CLIENT_ID,
        preset: 'payment-agent',
        parentAddress: PARENT_ADDRESS,
        allowlist: [{ entry_type: 'destination', entry_value: OTHER_DESTINATION }],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'db_conflict',
    });

    // The upsert was attempted (so the failure is from the right call site,
    // not a missed branch above it).
    expect(dbInsertCalls.some((c) => c.table === 'spend_policies')).toBe(true);

    // Critical invariant: NO on-ledger work was kicked off. If
    // grantPermission ran, the SignerListSet would still validate even
    // though the caller failed, leaving an orphaned active agent.
    expect(grantPermissionMock).not.toHaveBeenCalled();
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

// ── getAgent / listAgents ──────────────────────────────────────────────────
// Read endpoints. Both functions must construct AgentView WITHOUT
// `agent_seed` and WITHOUT `grant_tx_id` — that contract is critical
// (the seed lives only in accounts.master_key_ref after provisioning;
// the grant tx id is a POST-response detail).

const SAMPLE_AGENT_ROW = {
  id: 'agent-uuid-1',
  preset: 'payment-agent',
  parentAddress: PARENT_ADDRESS,
  agentAddress: 'rAGENT00000000000000000000000',
  label: 'invoice-bot',
  status: 'active',
  createdAt: new Date('2026-04-27T00:00:00Z'),
};

describe('getAgent', () => {
  it('returns null when the agent row is missing or wrong tenant', async () => {
    dbSelectResults.agents_joined = []; // join produces no row
    const result = await getAgent(CLIENT_ID, 'agent-uuid-1');
    expect(result).toBeNull();
  });

  it('returns the AgentView WITHOUT agent_seed or grant_tx_id', async () => {
    dbSelectResults.agents_joined = [SAMPLE_AGENT_ROW];
    dbSelectResults.agent_allowlists = [
      { entryType: 'destination', entryValue: OTHER_DESTINATION },
    ];
    dbSelectResults.spend_policies = [
      {
        maxXrpPerTxDrops: '10000000',
        dailyXrpLimitDrops: '100000000',
        isActive: true,
      },
    ];

    const result = await getAgent(CLIENT_ID, 'agent-uuid-1');

    expect(result).not.toBeNull();
    if (!result) throw new Error('unreachable');
    expect(result.id).toBe('agent-uuid-1');
    expect(result.parent_address).toBe(PARENT_ADDRESS);
    expect(result.status).toBe('active');
    expect(result.allowlist).toEqual([
      { entry_type: 'destination', entry_value: OTHER_DESTINATION },
    ]);
    expect(result.spend_policy).toEqual({
      max_xrp_per_tx_drops: '10000000',
      daily_xrp_limit_drops: '100000000',
    });

    // Critical: read path never returns the seed or the provisioning tx id.
    expect('agent_seed' in result).toBe(false);
    expect('grant_tx_id' in result).toBe(false);
  });

  it('surfaces null caps when no spend_policy row exists', async () => {
    dbSelectResults.agents_joined = [SAMPLE_AGENT_ROW];
    dbSelectResults.agent_allowlists = [];
    dbSelectResults.spend_policies = []; // no row

    const result = await getAgent(CLIENT_ID, 'agent-uuid-1');
    expect(result?.spend_policy).toEqual({
      max_xrp_per_tx_drops: null,
      daily_xrp_limit_drops: null,
    });
  });

  it('surfaces null caps when spend_policy row is is_active=false', async () => {
    dbSelectResults.agents_joined = [SAMPLE_AGENT_ROW];
    dbSelectResults.agent_allowlists = [];
    dbSelectResults.spend_policies = [
      {
        maxXrpPerTxDrops: '10000000',
        dailyXrpLimitDrops: '100000000',
        isActive: false,
      },
    ];

    const result = await getAgent(CLIENT_ID, 'agent-uuid-1');
    // is_active=false is the platform's "policy installed but disabled"
    // signal — read like no policy at all so the UI can't show stale caps
    // that aren't actually enforced.
    expect(result?.spend_policy).toEqual({
      max_xrp_per_tx_drops: null,
      daily_xrp_limit_drops: null,
    });
  });
});

describe('listAgents', () => {
  it('returns empty array when the client has no agents', async () => {
    dbSelectResults.agents_joined = [];
    const result = await listAgents(CLIENT_ID);
    expect(result).toEqual([]);
  });

  it('returns mapped views for each row, none with agent_seed or grant_tx_id', async () => {
    dbSelectResults.agents_joined = [
      SAMPLE_AGENT_ROW,
      { ...SAMPLE_AGENT_ROW, id: 'agent-uuid-2', status: 'pending' },
    ];
    // listAgents shares one allowlist source per call (the mock returns the
    // same dbSelectResults.agent_allowlists for every loadAllowlist), which
    // is fine for shape verification — the real DB scopes by agentId via
    // the WHERE clause.
    dbSelectResults.agent_allowlists = [
      { entryType: 'destination', entryValue: OTHER_DESTINATION },
    ];
    dbSelectResults.spend_policies = [
      {
        maxXrpPerTxDrops: '10000000',
        dailyXrpLimitDrops: '100000000',
        isActive: true,
      },
    ];

    const result = await listAgents(CLIENT_ID);

    expect(result).toHaveLength(2);
    expect(result[0]?.status).toBe('active');
    expect(result[1]?.status).toBe('pending');
    for (const view of result) {
      expect('agent_seed' in view).toBe(false);
      expect('grant_tx_id' in view).toBe(false);
    }
  });
});

// ── revokeAgent (DELETE /v1/agents/:id) ─────────────────────────────────────
// Mirrors revokePermission's staging pattern: agents.pendingRevocation flag
// + delegated to permission.service which queues the SignerListSet. The
// txConfirmer commits status='revoked' on tesSUCCESS (covered separately
// in apps/worker/src/jobs/txConfirmer.test.ts).

describe('revokeAgent', () => {
  it('404 when the agent does not belong to the caller', async () => {
    dbSelectResults.agents_joined = []; // no row owned by clientId
    await expect(
      revokeAgent({ clientId: CLIENT_ID, agentId: 'agent-uuid-1' }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_found',
    });
    expect(revokePermissionMock).not.toHaveBeenCalled();
  });

  it("409 when the agent is in status='pending' (not yet on-ledger active)", async () => {
    dbSelectResults.agents_joined = [
      {
        id: 'agent-uuid-1',
        status: 'pending',
        pendingRevocation: false,
        agentAddress: 'rAGENT00000000000000000000000',
        parentAddress: PARENT_ADDRESS,
      },
    ];
    await expect(
      revokeAgent({ clientId: CLIENT_ID, agentId: 'agent-uuid-1' }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_revocable',
    });
    expect(revokePermissionMock).not.toHaveBeenCalled();
  });

  it('409 when pendingRevocation is already true (one revoke in flight)', async () => {
    dbSelectResults.agents_joined = [
      {
        id: 'agent-uuid-1',
        status: 'active',
        pendingRevocation: true, // already in flight
        agentAddress: 'rAGENT00000000000000000000000',
        parentAddress: PARENT_ADDRESS,
      },
    ];
    await expect(
      revokeAgent({ clientId: CLIENT_ID, agentId: 'agent-uuid-1' }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_already_revoking',
    });
    expect(revokePermissionMock).not.toHaveBeenCalled();
  });

  it('happy path: calls revokePermission and stages agents.pendingRevocation=true', async () => {
    dbSelectResults.agents_joined = [
      {
        id: 'agent-uuid-1',
        status: 'active',
        pendingRevocation: false,
        agentAddress: 'rAGENT00000000000000000000000',
        parentAddress: PARENT_ADDRESS,
      },
    ];

    const result = await revokeAgent({
      clientId: CLIENT_ID,
      agentId: 'agent-uuid-1',
      idempotencyKey: 'caller-uuid-1',
    });

    expect(result).toEqual({
      agent_id: 'agent-uuid-1',
      status: 'revoking',
      tx_id: 'revoke-tx-1',
    });

    // permission.service was called with the parent (delegator) and
    // agent address (delegate), and the idempotency key threaded through.
    expect(revokePermissionMock).toHaveBeenCalledTimes(1);
    const arg = revokePermissionMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.delegatorAddress).toBe(PARENT_ADDRESS);
    expect(arg.delegateAddress).toBe('rAGENT00000000000000000000000');
    expect(arg.idempotencyKey).toBe('caller-uuid-1');

    // The agents row was staged: pendingRevocation=true.
    const agentUpdate = dbUpdateCalls.find(
      (u) => (u as { pendingRevocation?: boolean }).pendingRevocation === true,
    );
    expect(agentUpdate).toBeDefined();
  });

  it("maps permission.service 'not_found' to agent_not_revocable (already revoked)", async () => {
    dbSelectResults.agents_joined = [
      {
        id: 'agent-uuid-1',
        status: 'active',
        pendingRevocation: false,
        agentAddress: 'rAGENT00000000000000000000000',
        parentAddress: PARENT_ADDRESS,
      },
    ];
    // Simulate the delegation having been already revoked out-of-band.
    revokePermissionMock.mockRejectedValueOnce(
      new MockedPermissionServiceError('not_found', 'no active delegation'),
    );

    await expect(
      revokeAgent({ clientId: CLIENT_ID, agentId: 'agent-uuid-1' }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_revocable',
    });
  });
});

// ── updateAgentAllowlist ─────────────────────────────────────────────────────
// PUT /v1/agents/:id/allowlist replaces the allowlist atomically without
// touching on-ledger state. Tests cover: cross-tenant 404, status gating
// (must be 'active', not pending_revocation), preset re-validation, the
// require-allowlist rule, transactional delete-then-insert, and rollback
// on transient transaction failure.

const ACTIVE_AGENT_ROW = {
  id: 'agent-uuid-1',
  preset: 'payment-agent',
  parentAddress: PARENT_ADDRESS,
  agentAddress: 'rAGENT00000000000000000000000',
  label: 'invoice-bot',
  status: 'active',
  pendingRevocation: false,
  createdAt: new Date('2026-04-27T00:00:00Z'),
};

describe('updateAgentAllowlist', () => {
  it('rejects with agent_not_found when no row matches client+agent', async () => {
    dbSelectResults.agents_joined = [];
    await expect(
      updateAgentAllowlist({
        clientId: CLIENT_ID,
        agentId: 'agent-uuid-1',
        allowlist: [
          {
            entry_type: 'destination',
            entry_value: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_found',
    });
    // Critical: no DB write happens when the row doesn't resolve.
    expect(dbDeleteCalls).toHaveLength(0);
    expect(dbInsertCalls).toHaveLength(0);
  });

  it("rejects with agent_not_updatable when status is not 'active'", async () => {
    dbSelectResults.agents_joined = [{ ...ACTIVE_AGENT_ROW, status: 'pending' }];
    await expect(
      updateAgentAllowlist({
        clientId: CLIENT_ID,
        agentId: 'agent-uuid-1',
        allowlist: [
          {
            entry_type: 'destination',
            entry_value: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_updatable',
    });
    expect(dbDeleteCalls).toHaveLength(0);
  });

  it('rejects with agent_not_updatable when pendingRevocation=true', async () => {
    // Even on 'active', a revoke in flight forbids allowlist mutation
    // — otherwise the revoke and the PUT race over the same agent state.
    dbSelectResults.agents_joined = [{ ...ACTIVE_AGENT_ROW, pendingRevocation: true }];
    await expect(
      updateAgentAllowlist({
        clientId: CLIENT_ID,
        agentId: 'agent-uuid-1',
        allowlist: [],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_updatable',
    });
  });

  it("rejects invalid_allowlist when an entry's shape is wrong for the preset", async () => {
    dbSelectResults.agents_joined = [ACTIVE_AGENT_ROW];
    dbSelectResults.spend_policies = [];
    await expect(
      updateAgentAllowlist({
        clientId: CLIENT_ID,
        agentId: 'agent-uuid-1',
        // payment-agent doesn't allow 'domain' entries.
        allowlist: [{ entry_type: 'domain', entry_value: 'a'.repeat(64) }],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'invalid_allowlist',
    });
    expect(dbDeleteCalls).toHaveLength(0);
  });

  it('rejects allowlist_required when preset requires it and the new list is empty', async () => {
    // payment-agent has requireAllowlist=true; replacing with [] is refused
    // for the same reason POST /v1/agents refuses an empty list at provision time.
    dbSelectResults.agents_joined = [ACTIVE_AGENT_ROW];
    await expect(
      updateAgentAllowlist({
        clientId: CLIENT_ID,
        agentId: 'agent-uuid-1',
        allowlist: [],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'allowlist_required',
    });
    expect(dbDeleteCalls).toHaveLength(0);
  });

  it('happy path: deletes existing rows then inserts the new ones inside a transaction', async () => {
    dbSelectResults.agents_joined = [ACTIVE_AGENT_ROW];
    dbSelectResults.spend_policies = [
      {
        maxXrpPerTxDrops: '10000000',
        dailyXrpLimitDrops: '100000000',
        isActive: true,
      },
    ];

    const newAllowlist = [
      {
        entry_type: 'destination' as const,
        entry_value: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
      },
      {
        entry_type: 'destination' as const,
        entry_value: 'rEAasdLBpUNBBXXfSk1NbggQjuv2qSyTJZ',
      },
    ];

    const result = await updateAgentAllowlist({
      clientId: CLIENT_ID,
      agentId: 'agent-uuid-1',
      allowlist: newAllowlist,
    });

    // Wipe-and-reinsert: exactly one delete on agent_allowlists, then one
    // insert with both rows.
    expect(dbDeleteCalls).toEqual([{ table: 'agent_allowlists' }]);
    const allowlistInsert = dbInsertCalls.find((c) => c.table === 'agent_allowlists');
    expect(allowlistInsert).toBeDefined();
    expect(allowlistInsert?.values).toEqual(
      newAllowlist.map((e) => ({
        agentId: 'agent-uuid-1',
        entryType: e.entry_type,
        entryValue: e.entry_value,
      })),
    );

    // Returned view echoes the new allowlist + the unchanged spend_policy
    // and never includes agent_seed / grant_tx_id (read-path contract).
    expect(result.allowlist).toEqual(newAllowlist);
    expect(result.spend_policy).toEqual({
      max_xrp_per_tx_drops: '10000000',
      daily_xrp_limit_drops: '100000000',
    });
    expect('agent_seed' in result).toBe(false);
    expect('grant_tx_id' in result).toBe(false);
  });

  it('happy path: empty allowlist is accepted for treasury-agent (no required entries)', async () => {
    dbSelectResults.agents_joined = [{ ...ACTIVE_AGENT_ROW, preset: 'treasury-agent' }];
    dbSelectResults.spend_policies = [];

    const result = await updateAgentAllowlist({
      clientId: CLIENT_ID,
      agentId: 'agent-uuid-1',
      allowlist: [],
    });

    // Delete still runs (always wipe before re-insert) but no insert call
    // for agent_allowlists when the new list is empty.
    expect(dbDeleteCalls).toEqual([{ table: 'agent_allowlists' }]);
    expect(dbInsertCalls.find((c) => c.table === 'agent_allowlists')).toBeUndefined();
    expect(result.allowlist).toEqual([]);
  });

  it('translates a transient transaction failure to db_conflict (no on-ledger work in flight to roll back)', async () => {
    dbSelectResults.agents_joined = [ACTIVE_AGENT_ROW];
    dbTransactionError = new Error('connection lost mid-transaction');

    await expect(
      updateAgentAllowlist({
        clientId: CLIENT_ID,
        agentId: 'agent-uuid-1',
        allowlist: [
          {
            entry_type: 'destination',
            entry_value: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'db_conflict',
    });
  });

  it('scopes by clientId — agent owned by a different tenant returns agent_not_found, never leaks state', async () => {
    // Mock returns no joined rows when the WHERE doesn't match (it's the
    // service's `eq(clientId, ...)` predicate that does the cross-tenant
    // gate; the mock just honors whatever we seed).
    dbSelectResults.agents_joined = [];
    await expect(
      updateAgentAllowlist({
        clientId: 'tenant-other',
        agentId: 'agent-uuid-1',
        allowlist: [],
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_found',
    });
  });
});

// ── updateAgentSpendPolicy ──────────────────────────────────────────────────
// PUT /v1/agents/:id/spend-policy upserts spend_policies for the client.
// Tests cover: cross-tenant 404, status gating, partial updates that
// preserve untouched fields, null clears the cap, and cache-invalidation
// after a successful write.

describe('updateAgentSpendPolicy', () => {
  it('rejects with agent_not_found when no row matches client+agent', async () => {
    dbSelectResults.agents_joined = [];
    await expect(
      updateAgentSpendPolicy({
        clientId: CLIENT_ID,
        agentId: 'agent-uuid-1',
        maxXrpPerTxDrops: '10000000',
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_found',
    });
    // No upsert when the agent doesn't resolve.
    expect(dbInsertCalls.find((c) => c.table === 'spend_policies')).toBeUndefined();
    expect(invalidateSpendPolicyCacheMock).not.toHaveBeenCalled();
  });

  it("rejects with agent_not_updatable when status is not 'active'", async () => {
    dbSelectResults.agents_joined = [{ ...ACTIVE_AGENT_ROW, status: 'revoked' }];
    await expect(
      updateAgentSpendPolicy({
        clientId: CLIENT_ID,
        agentId: 'agent-uuid-1',
        maxXrpPerTxDrops: '10000000',
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_updatable',
    });
    expect(dbInsertCalls.find((c) => c.table === 'spend_policies')).toBeUndefined();
  });

  it('rejects with agent_not_updatable when pendingRevocation=true', async () => {
    dbSelectResults.agents_joined = [{ ...ACTIVE_AGENT_ROW, pendingRevocation: true }];
    await expect(
      updateAgentSpendPolicy({
        clientId: CLIENT_ID,
        agentId: 'agent-uuid-1',
        dailyXrpLimitDrops: '100000000',
      }),
    ).rejects.toMatchObject({
      name: 'AgentServiceError',
      code: 'agent_not_updatable',
    });
  });

  it('preserves the untouched cap when only one field is provided', async () => {
    dbSelectResults.agents_joined = [ACTIVE_AGENT_ROW];
    // existing spend_policies row has both caps; the update only sets
    // max_xrp_per_tx_drops, so daily_xrp_limit_drops must be carried over.
    dbSelectResults.spend_policies = [
      {
        maxXrpPerTxDrops: '5000000',
        dailyXrpLimitDrops: '50000000',
        isActive: true,
      },
    ];
    await updateAgentSpendPolicy({
      clientId: CLIENT_ID,
      agentId: 'agent-uuid-1',
      maxXrpPerTxDrops: '20000000',
    });
    const upsert = dbInsertCalls.find((c) => c.table === 'spend_policies');
    expect(upsert).toBeDefined();
    const vals = upsert?.values as Record<string, unknown>;
    expect(vals.maxXrpPerTxDrops).toBe('20000000');
    expect(vals.dailyXrpLimitDrops).toBe('50000000');
    expect(vals.isActive).toBe(true);
    expect(invalidateSpendPolicyCacheMock).toHaveBeenCalledWith(CLIENT_ID);
  });

  it('clears a cap when the field is explicitly null', async () => {
    dbSelectResults.agents_joined = [ACTIVE_AGENT_ROW];
    dbSelectResults.spend_policies = [
      {
        maxXrpPerTxDrops: '5000000',
        dailyXrpLimitDrops: '50000000',
        isActive: true,
      },
    ];
    await updateAgentSpendPolicy({
      clientId: CLIENT_ID,
      agentId: 'agent-uuid-1',
      dailyXrpLimitDrops: null,
    });
    const upsert = dbInsertCalls.find((c) => c.table === 'spend_policies');
    const vals = upsert?.values as Record<string, unknown>;
    expect(vals.dailyXrpLimitDrops).toBeNull();
    // Untouched field still threaded.
    expect(vals.maxXrpPerTxDrops).toBe('5000000');
  });

  it('seeds null caps when no spend_policies row exists yet', async () => {
    dbSelectResults.agents_joined = [ACTIVE_AGENT_ROW];
    dbSelectResults.spend_policies = [];
    await updateAgentSpendPolicy({
      clientId: CLIENT_ID,
      agentId: 'agent-uuid-1',
      maxXrpPerTxDrops: '10000000',
    });
    const upsert = dbInsertCalls.find((c) => c.table === 'spend_policies');
    const vals = upsert?.values as Record<string, unknown>;
    expect(vals.maxXrpPerTxDrops).toBe('10000000');
    expect(vals.dailyXrpLimitDrops).toBeNull();
  });
});
