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

function agentErrorResponse(err: AgentServiceError) {
  switch (err.code) {
    case 'invalid_preset':
    case 'invalid_allowlist':
    case 'allowlist_required':
      return { error: err.message, status: 400 } as const;
    case 'parent_not_found':
      return { error: 'Parent account not found', status: 404 } as const;
    case 'parent_not_funded':
      return { error: err.message, status: 409 } as const;
    case 'enqueue_failed':
      return {
        error: 'Failed to enqueue — please retry',
        status: 503,
      } as const;
    case 'db_conflict':
      return { error: 'Conflict — please retry', status: 409 } as const;
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
