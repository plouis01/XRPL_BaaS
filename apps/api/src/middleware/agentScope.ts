// Agent-scope guard.
//
// Agents are payment-only. The preset registry only ships `Payment` as a
// granted permission, the service-layer authorization gate
// (authorizeAgentPayment) is wired into payment.service.sendPayment, and
// nothing else.
//
// Every OTHER state-changing endpoint must reject agent-bound API keys at
// the route layer. Without this gate, an agent-bound key could:
//
//   - POST /accounts            mint new accounts under the tenant
//   - POST /accounts/:a/delete  delete a parent account, sweep its reserves
//   - POST /tokens              issue tokens against any owned account
//   - POST /tokens/:id/freeze   freeze tokens issued by the tenant
//   - POST /tokens/:id/clawback claw back tokens from any holder
//   - POST /dex/offers          place trades that bypass the payment allowlist
//   - POST /credentials         issue credentials in the tenant's name
//   - POST /domains             create / mutate permissioned domains
//   - POST /permissions         grant signing authority to NEW delegates
//                               (privilege escalation: agent → super-agent)
//   - POST /agents              provision MORE agents under the tenant
//   - POST /webhooks            redirect tx events to an attacker URL
//   - POST /payments/escrows    move funds via a path that doesn't run
//                               authorizeAgentPayment
//   - POST /payments/batch      same — bulk-move via the batch path
//
// The refusal is a flat 403 with no body details; a compromised agent key
// shouldn't get richer error information than a misconfigured tenant.

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.ts';

export const requireNotAgent: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('agentId')) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return next();
};
