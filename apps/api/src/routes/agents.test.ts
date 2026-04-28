// Route-level HTTP tests for /v1/agents (VISION.md agent launcher).
//
// Verifies the wire shape: provisionAgent service errors → correct HTTP
// status codes, the seed-once contract on success (response body includes
// agent_seed and the route doesn't strip it), and Zod-level rejection
// of malformed bodies.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const mockProvisionAgent = vi.fn();
const mockGetAgent = vi.fn();
const mockListAgents = vi.fn();
const mockRevokeAgent = vi.fn();

vi.mock('../services/agent.service.ts', () => ({
  provisionAgent: (...args: unknown[]) => mockProvisionAgent(...args),
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
  listAgents: (...args: unknown[]) => mockListAgents(...args),
  revokeAgent: (...args: unknown[]) => mockRevokeAgent(...args),
  AgentServiceError: class AgentServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'AgentServiceError';
    }
  },
}));

vi.mock('@railforge/db', () => ({
  db: {},
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  schema: { apiKeys: {} },
}));

const { default: agentsRoute } = await import('./agents.ts');
const { AgentServiceError } = await import('../services/agent.service.ts');

const VALID_PARENT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const VALID_DEST = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    await next();
  });
  app.route('/agents', agentsRoute);
  return app;
}

function bareValidBody(): Record<string, unknown> {
  return {
    preset: 'payment-agent',
    parent_address: VALID_PARENT,
    allowlist: [{ entry_type: 'destination', entry_value: VALID_DEST }],
  };
}

describe('POST /agents — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('201 with agent_seed surfaced exactly once on the response body', async () => {
    mockProvisionAgent.mockResolvedValue({
      id: 'agent-1',
      preset: 'payment-agent',
      parent_address: VALID_PARENT,
      agent_address: 'rAGENT000000000',
      label: null,
      status: 'pending',
      allowlist: [{ entry_type: 'destination', entry_value: VALID_DEST }],
      spend_policy: {
        max_xrp_per_tx_drops: '10000000',
        daily_xrp_limit_drops: '100000000',
      },
      created_at: new Date('2026-04-27T00:00:00Z'),
      agent_seed: 'sEdT...REDACTED_IN_LOG_ONLY',
      grant_tx_id: 'grant-tx-1',
    });

    const app = makeApp();
    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bareValidBody()),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe('agent-1');
    expect(body.status).toBe('pending');
    // The seed is in the response — this is the "exactly once" contract.
    // No GET endpoint should ever return it; that's enforced at the GET
    // layer, not here. This test pins that POST DOES return it.
    expect(body.agent_seed).toBe('sEdT...REDACTED_IN_LOG_ONLY');
    expect(body.grant_tx_id).toBe('grant-tx-1');
  });

  it('threads the Idempotency-Key header into the service call', async () => {
    mockProvisionAgent.mockResolvedValue({
      id: 'agent-2',
      preset: 'payment-agent',
      parent_address: VALID_PARENT,
      agent_address: 'rAGENT000000001',
      label: null,
      status: 'pending',
      allowlist: [],
      spend_policy: {
        max_xrp_per_tx_drops: '10000000',
        daily_xrp_limit_drops: '100000000',
      },
      created_at: new Date(),
      agent_seed: 'sEdT...x',
      grant_tx_id: 'grant-tx-2',
    });

    const app = makeApp();
    await app.request('/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'caller-supplied-uuid',
      },
      body: JSON.stringify(bareValidBody()),
    });

    expect(mockProvisionAgent).toHaveBeenCalledTimes(1);
    const arg = mockProvisionAgent.mock.calls[0]?.[0] as {
      idempotencyKey?: string;
    };
    expect(arg.idempotencyKey).toBe('caller-supplied-uuid');
  });

  it('passes spend_policy override through to the service', async () => {
    mockProvisionAgent.mockResolvedValue({
      id: 'agent-3',
      preset: 'treasury-agent',
      parent_address: VALID_PARENT,
      agent_address: 'rAGENT000000002',
      label: null,
      status: 'pending',
      allowlist: [],
      spend_policy: {
        max_xrp_per_tx_drops: null,
        daily_xrp_limit_drops: '50000000',
      },
      created_at: new Date(),
      agent_seed: 'sEdT...y',
      grant_tx_id: 'grant-tx-3',
    });

    const app = makeApp();
    await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset: 'treasury-agent',
        parent_address: VALID_PARENT,
        spend_policy: {
          max_xrp_per_tx_drops: null,
          daily_xrp_limit_drops: '50000000',
        },
      }),
    });

    const arg = mockProvisionAgent.mock.calls[0]?.[0] as {
      spendPolicy?: {
        maxXrpPerTxDrops: string | null;
        dailyXrpLimitDrops: string | null;
      };
    };
    expect(arg.spendPolicy?.maxXrpPerTxDrops).toBeNull();
    expect(arg.spendPolicy?.dailyXrpLimitDrops).toBe('50000000');
  });
});

describe('POST /agents — validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400 on unknown preset', async () => {
    const app = makeApp();
    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bareValidBody(), preset: 'defi-agent' }),
    });
    expect(res.status).toBe(400);
    expect(mockProvisionAgent).not.toHaveBeenCalled();
  });

  it('400 on malformed parent_address', async () => {
    const app = makeApp();
    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...bareValidBody(),
        parent_address: 'not-an-r-address',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('400 on missing body', async () => {
    const app = makeApp();
    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('400 on quorum out of range', async () => {
    const app = makeApp();
    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bareValidBody(), quorum: 0 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /agents — service-error mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  // Each switch arm in agentErrorResponse: code → status. The service throws
  // these under specific conditions (covered in agent.service.test.ts) — here
  // we just pin the route's HTTP translation so a future refactor can't
  // silently change the wire status.
  it.each([
    ['invalid_preset', 400],
    ['invalid_allowlist', 400],
    ['allowlist_required', 400],
    ['parent_is_agent', 400],
    ['parent_not_found', 404],
    ['parent_not_funded', 409],
    ['enqueue_failed', 503],
    ['db_conflict', 409],
    ['agent_not_found', 404],
    ['agent_not_active', 403],
    ['source_not_parent', 403],
    ['destination_not_allowlisted', 403],
    ['token_not_allowlisted', 403],
  ] as const)('maps %s → %i', async (code, status) => {
    mockProvisionAgent.mockRejectedValue(new AgentServiceError(code, `simulated ${code}`));

    const app = makeApp();
    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bareValidBody()),
    });

    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('rethrows non-AgentServiceError (500)', async () => {
    mockProvisionAgent.mockRejectedValue(new Error('unexpected runtime crash'));

    const app = makeApp();
    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bareValidBody()),
    });
    expect(res.status).toBe(500);
  });
});

const VALID_AGENT_ID = '11111111-2222-4333-8444-555555555555';

function viewWithoutSeed() {
  return {
    id: VALID_AGENT_ID,
    preset: 'payment-agent',
    parent_address: VALID_PARENT,
    agent_address: 'rAGENT00000000000000000000000',
    label: 'invoice-bot',
    status: 'active',
    allowlist: [{ entry_type: 'destination', entry_value: VALID_DEST }],
    spend_policy: {
      max_xrp_per_tx_drops: '10000000',
      daily_xrp_limit_drops: '100000000',
    },
    created_at: new Date('2026-04-27T00:00:00Z'),
    // No agent_seed, no grant_tx_id — read-path contract.
  };
}

describe('GET /agents/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400 on malformed agent id (not a UUID)', async () => {
    const app = makeApp();
    const res = await app.request('/agents/not-a-uuid');
    expect(res.status).toBe(400);
    expect(mockGetAgent).not.toHaveBeenCalled();
  });

  it('404 when the agent does not belong to the client', async () => {
    mockGetAgent.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request(`/agents/${VALID_AGENT_ID}`);
    expect(res.status).toBe(404);
    // The service is responsible for cross-tenant scoping — the route
    // simply maps null → 404. Confirm we passed the auth'd clientId in.
    expect(mockGetAgent).toHaveBeenCalledTimes(1);
    expect(mockGetAgent.mock.calls[0]?.[0]).toBe('client-1');
  });

  it('200 returns the AgentView with no agent_seed', async () => {
    mockGetAgent.mockResolvedValue(viewWithoutSeed());
    const app = makeApp();
    const res = await app.request(`/agents/${VALID_AGENT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(VALID_AGENT_ID);
    expect(body.status).toBe('active');
    expect('agent_seed' in body).toBe(false);
    expect('grant_tx_id' in body).toBe(false);
  });
});

describe('GET /agents (list)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 with empty data array when client has no agents', async () => {
    mockListAgents.mockResolvedValue([]);
    const app = makeApp();
    const res = await app.request('/agents');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('200 with mapped views, none containing agent_seed', async () => {
    mockListAgents.mockResolvedValue([
      viewWithoutSeed(),
      {
        ...viewWithoutSeed(),
        id: '22222222-2222-4333-8444-555555555555',
        status: 'pending',
      },
    ]);
    const app = makeApp();
    const res = await app.request('/agents');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.status).toBe('active');
    expect(body.data[1]?.status).toBe('pending');
    for (const view of body.data) {
      expect('agent_seed' in view).toBe(false);
      expect('grant_tx_id' in view).toBe(false);
    }
    // Confirm we passed the auth'd clientId.
    expect(mockListAgents).toHaveBeenCalledTimes(1);
    expect(mockListAgents.mock.calls[0]?.[0]).toBe('client-1');
  });
});

describe('DELETE /agents/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400 on malformed id (not a UUID)', async () => {
    const app = makeApp();
    const res = await app.request('/agents/not-a-uuid', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(mockRevokeAgent).not.toHaveBeenCalled();
  });

  it('202 on success — returns the staged result', async () => {
    mockRevokeAgent.mockResolvedValue({
      agent_id: VALID_AGENT_ID,
      status: 'revoking',
      tx_id: 'tx-revoke-1',
    });
    const app = makeApp();
    const res = await app.request(`/agents/${VALID_AGENT_ID}`, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': 'caller-uuid-1' },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.agent_id).toBe(VALID_AGENT_ID);
    expect(body.status).toBe('revoking');
    expect(body.tx_id).toBe('tx-revoke-1');

    // The caller's Idempotency-Key was threaded into the service.
    const arg = mockRevokeAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.idempotencyKey).toBe('caller-uuid-1');
    expect(arg.clientId).toBe('client-1');
    expect(arg.agentId).toBe(VALID_AGENT_ID);
  });

  it.each([
    ['agent_not_found', 404],
    ['agent_not_revocable', 409],
    ['agent_already_revoking', 409],
    ['enqueue_failed', 503],
    ['db_conflict', 409],
  ] as const)('maps %s → %i on revocation paths', async (code, status) => {
    mockRevokeAgent.mockRejectedValue(new AgentServiceError(code, `simulated ${code}`));
    const app = makeApp();
    const res = await app.request(`/agents/${VALID_AGENT_ID}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(status);
  });
});
