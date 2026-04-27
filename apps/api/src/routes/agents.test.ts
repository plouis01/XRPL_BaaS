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

vi.mock('../services/agent.service.ts', () => ({
  provisionAgent: (...args: unknown[]) => mockProvisionAgent(...args),
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
