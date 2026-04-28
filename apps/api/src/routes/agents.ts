// Agent launcher routes (VISION.md).
//
// POST   /v1/agents       — one-shot provisioning: generate delegate keypair,
//                            grant on-ledger authority, install spend policy,
//                            insert allowlist. Returns the delegate seed
//                            EXACTLY ONCE — subsequent GETs never include it.
// GET    /v1/agents       — list agents for the authenticated client.
// GET    /v1/agents/:id   — single agent. Used by callers polling for the
//                            'pending' → 'active' transition after POST.
//
// PUT/DELETE come in a follow-up (VISION.md "One-week MVP").

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  AgentServiceError,
  getAgent,
  listAgents,
  provisionAgent,
  revokeAgent,
} from '../services/agent.service.ts';
import type { AppEnv } from '../types.ts';
import { provisionAgentSchema } from '../validators/schemas.ts';

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
  }
}

agents.post('/', zValidator('json', provisionAgentSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await provisionAgent({
      clientId,
      preset: body.preset,
      parentAddress: body.parent_address,
      label: body.label,
      allowlist: body.allowlist,
      spendPolicy: body.spend_policy
        ? {
            maxXrpPerTxDrops: body.spend_policy.max_xrp_per_tx_drops,
            dailyXrpLimitDrops: body.spend_policy.daily_xrp_limit_drops,
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
