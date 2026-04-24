// Agent launcher routes (VISION.md).
//
// POST /v1/agents — one-shot provisioning: generate delegate keypair,
// grant on-ledger authority on the parent account, install per-client spend
// policy, insert destination/token/domain allowlist. Returns the delegate
// seed EXACTLY ONCE — subsequent GETs never include it.
//
// Only POST is exposed in this first cut; GET/PUT/DELETE come in the
// follow-up described in VISION.md "One-week MVP".

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { AgentServiceError, provisionAgent } from '../services/agent.service.ts';
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

export default agents;
