// Unit tests for requireNotAgent (apps/api/src/middleware/agentScope.ts).
//
// Single responsibility: refuse the request when c.get('agentId') is set.
// Mounted on every state-changing router that's not /payments — and on the
// /payments/escrows + /payments/batch sub-paths inside payments.ts. Without
// this gate, an agent-bound key could call any endpoint that doesn't run
// authorizeAgentPayment (escrow, batch, DEX, token issuance, account
// mutations, etc).

import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../types.ts';
import { requireNotAgent } from './agentScope.ts';

let nextCalled = 0;

function makeApp(opts: { agentId: string | null }) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    if (opts.agentId !== null) c.set('agentId', opts.agentId);
    await next();
  });
  app.use('*', requireNotAgent);
  app.post('/protected', (c) => {
    nextCalled += 1;
    return c.json({ ok: true }, 200);
  });
  return app;
}

beforeEach(() => {
  nextCalled = 0;
});

describe('requireNotAgent', () => {
  it('passes through when agentId is unset (regular client-scoped key)', async () => {
    const app = makeApp({ agentId: null });
    const res = await app.request('/protected', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(nextCalled).toBe(1);
  });

  it('returns 403 when agentId is set', async () => {
    const app = makeApp({ agentId: 'agent-uuid-1' });
    const res = await app.request('/protected', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(nextCalled).toBe(0); // handler must NOT run
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Forbidden');
  });

  it('returns 403 with no body details (compromised agent gets no extra info)', async () => {
    const app = makeApp({ agentId: 'agent-uuid-2' });
    const res = await app.request('/protected', { method: 'POST' });
    const body = (await res.json()) as Record<string, unknown>;
    // Only `error: 'Forbidden'` — no agent_id echoed back, no hint about
    // the binding, no telemetry stuck in the response. A compromised
    // agent key shouldn't reveal more than a misconfigured tenant.
    expect(Object.keys(body)).toEqual(['error']);
  });
});
