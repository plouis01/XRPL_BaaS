// Agent launcher routes (VISION.md).
//
// POST   /v1/agents                 — one-shot provisioning: generate delegate keypair,
//                                       grant on-ledger authority, install spend policy,
//                                       insert allowlist. Returns the delegate seed
//                                       EXACTLY ONCE — subsequent GETs never include it.
// GET    /v1/agents                 — list agents for the authenticated client.
// GET    /v1/agents/:id             — single agent. Used by callers polling for the
//                                       'pending' → 'active' transition after POST.
// PUT    /v1/agents/:id/allowlist   — replace the allowlist on a live agent (pure DB).
// PUT    /v1/agents/:id/spend-policy — change per-tx / daily XRP caps (pure DB).
// DELETE /v1/agents/:id             — stage a revocation (queues a SignerListSet).

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  AgentServiceError,
  getAgent,
  listAgents,
  provisionAgent,
  revokeAgent,
  updateAgentAllowlist,
  updateAgentSpendPolicy,
} from '../services/agent.service.ts';
import type { AppEnv } from '../types.ts';
import {
  provisionAgentSchema,
  updateAgentAllowlistSchema,
  updateAgentSpendPolicySchema,
} from '../validators/schemas.ts';

const agents = new Hono<AppEnv>();

// revocationCheck is mounted globally on /v1 — no per-router duplicate.

function agentErrorResponse(err: AgentServiceError): {
  error: string;
  status: 400 | 403 | 404 | 409 | 503;
} {
  switch (err.code) {
    case 'invalid_preset':
    case 'invalid_allowlist':
    case 'allowlist_required':
    case 'parent_is_agent':
      return { error: err.message, status: 400 };
    case 'parent_not_found':
      return { error: 'Parent account not found', status: 404 };
    case 'parent_not_funded':
      return { error: err.message, status: 409 };
    case 'enqueue_failed':
      return { error: 'Failed to enqueue — please retry', status: 503 };
    case 'db_conflict':
      return { error: 'Conflict — please retry', status: 409 };
    // Authorization codes — thrown by authorizeAgentPayment, not
    // provisionAgent. They shouldn't normally reach this route, but the
    // switch must be exhaustive. Map to 403 with the original message so
    // any accidental bubble-up surfaces cleanly instead of 500'ing.
    case 'agent_not_found':
      return { error: 'Agent not found', status: 404 };
    case 'agent_not_active':
    case 'source_not_parent':
    case 'destination_not_allowlisted':
    case 'token_not_allowlisted':
      return { error: err.message, status: 403 };
    // Revocation codes (DELETE /v1/agents/:id).
    case 'agent_not_revocable':
    case 'agent_already_revoking':
      return { error: err.message, status: 409 };
    // Allowlist update gate (PUT /v1/agents/:id/allowlist).
    case 'agent_not_updatable':
      return { error: err.message, status: 409 };
  }
}

agents.post('/', zValidator('json', provisionAgentSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  // REVIEW B1: the 201 response body carries the delegate seed in
  // `agent_seed`. The idempotency middleware would otherwise persist
  // the response in Redis for 24 h, turning the cache into a credential
  // store and breaking the "seed returned exactly once" contract
  // documented in agent.service.ts. Opt out of body caching while
  // keeping the lock + 409 dedup semantics. Concurrent duplicates with
  // the same Idempotency-Key still get one winner; a serial replay
  // re-runs the handler. Re-running is safe enough because (a) the
  // underlying SignerListSet insert is constrained by
  // UNIQUE(client_id, idempotency_key) on the transactions table, so
  // double-submits to rippled are blocked at the DB layer, and (b) on
  // a 23505 collision provisionAgent surfaces 'db_conflict' (409)
  // rather than minting a second agent.
  c.set('skipIdempotencyCache', true);
  try {
    const result = await provisionAgent({
      clientId,
      preset: body.preset,
      parentAddress: body.parent_address,
      label: body.label,
      allowlist: body.allowlist,
      spendPolicy: body.spend_policy
        ? {
            maxPerTxUsdCents: body.spend_policy.max_per_tx_usd_cents,
            dailyLimitUsdCents: body.spend_policy.daily_limit_usd_cents,
          }
        : undefined,
      quorum: body.quorum,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof AgentServiceError) {
      const r = agentErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// UUID v4 shape — same check as dashboard.ts /transactions/:id. Prevents a
// malformed id from reaching Drizzle (Postgres throws on bad uuid casts).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

agents.get('/', async (c) => {
  const clientId = c.get('clientId');
  const data = await listAgents(clientId);
  return c.json({ data });
});

agents.get('/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: 'invalid agent id' }, 400);
  }
  const agent = await getAgent(clientId, id);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  return c.json(agent);
});

// PUT /v1/agents/:id/allowlist — replace the allowlist on a live agent.
// Pure DB op (no on-ledger work) since the on-chain SignerListSet doesn't
// reference individual destinations / tokens. Body shape matches the
// provision-time `allowlist` field; entries are re-validated against the
// agent's stored preset (which is immutable post-provision).
agents.put('/:id/allowlist', zValidator('json', updateAgentAllowlistSchema), async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: 'invalid agent id' }, 400);
  }
  const body = c.req.valid('json');
  try {
    const result = await updateAgentAllowlist({
      clientId,
      agentId: id,
      allowlist: body.allowlist,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof AgentServiceError) {
      const r = agentErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// PUT /v1/agents/:id/spend-policy — change the XRP spend caps on a live
// agent. Pure DB op (UPSERT into spend_policies). Caps are currently
// per-client (VISION.md flags an agent_id column for true per-agent
// isolation), so changes affect every agent under the same client.
// Effects apply to the live counter immediately — see service docstring.
agents.put('/:id/spend-policy', zValidator('json', updateAgentSpendPolicySchema), async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: 'invalid agent id' }, 400);
  }
  const body = c.req.valid('json');
  try {
    const result = await updateAgentSpendPolicy({
      clientId,
      agentId: id,
      maxPerTxUsdCents: body.max_per_tx_usd_cents,
      dailyLimitUsdCents: body.daily_limit_usd_cents,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof AgentServiceError) {
      const r = agentErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// DELETE /v1/agents/:id — stage a revocation. Queues a SignerListSet that
// strips the delegate; agents.pendingRevocation is set to true and the
// txConfirmer flips status='revoked' (or clears the flag on failure) when
// the tx validates. Body-less; idempotency-key is honored.
agents.delete('/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: 'invalid agent id' }, 400);
  }
  try {
    const result = await revokeAgent({
      clientId,
      agentId: id,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json(result, 202);
  } catch (err) {
    if (err instanceof AgentServiceError) {
      const r = agentErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

export default agents;
