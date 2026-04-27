import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { logger } from './logger.ts';
import { requireNotAgent } from './middleware/agentScope.ts';
import { auditLog } from './middleware/auditLog.ts';
import { auth } from './middleware/auth.ts';
import { corsMiddleware } from './middleware/cors.ts';
import { envGuard } from './middleware/envGuard.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import { idempotency } from './middleware/idempotency.ts';
import { ipRateLimit } from './middleware/ipRateLimit.ts';
import { rateLimit } from './middleware/rateLimit.ts';
import { revocationCheck } from './middleware/revocationCheck.ts';
import accountsRoute from './routes/accounts.ts';
import agentsRoute from './routes/agents.ts';
import credentialsRoute from './routes/credentials.ts';
import dashboardRoute from './routes/dashboard.ts';
import dashboardSessionRoute from './routes/dashboardSession.ts';
import dexRoute from './routes/dex.ts';
import domainsRoute from './routes/domains.ts';
import paymentsRoute from './routes/payments.ts';
import permissionsRoute from './routes/permissions.ts';
import tokensRoute from './routes/tokens.ts';
import webhooksRoute from './routes/webhooks.ts';
import type { AppEnv } from './types.ts';

const app = new Hono<AppEnv>();

app.onError(errorHandler);

// CORS — allows dashboard origin (DASHBOARD_ORIGIN env var, defaults to localhost:5173).
// Applied app-wide so OPTIONS preflight succeeds before auth runs.
app.use('*', corsMiddleware);

// Public health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// REVIEW.md HIGH-03: dashboard session endpoints (login / logout). Mounted
// BEFORE the /v1 auth chain because login supplies the key in the body —
// the request is pre-auth by definition. IP rate limit still applies so
// brute-force attempts bottleneck on the same pre-auth bucket.
const sessionRoot = new Hono<AppEnv>();
// REVIEW.md MED-15: sessionRoot is a sibling of /v1, not a child, so it
// does NOT inherit the 1 MB bodyLimit applied below. Without a tighter cap
// a caller can POST a multi-GB JSON payload to /v1/dashboard/session and
// force Hono to buffer it before Zod rejects. 64 KB is ~256× the realistic
// login body { "api_key": "rf_test_..." } and bounds attacker memory use.
sessionRoot.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
);
sessionRoot.use('*', ipRateLimit);
sessionRoot.route('/', dashboardSessionRoute);
app.route('/v1/dashboard/session', sessionRoot);

// All /v1/* routes are authenticated, rate-limited, and idempotency-aware.
//
// Middleware ORDER matters:
//   1. ipRateLimit — pre-auth IP bucket. Bounds anonymous brute-force traffic
//      BEFORE the database is touched. Without this, failed-auth requests
//      bypass rate limiting entirely (they never reach the per-key limiter).
//   2. auth        — HMAC-SHA256 API key lookup, sets clientId/apiKeyId.
//   3. envGuard    — rejects keys whose environment doesn't match the server's XRPL_NETWORK.
//   4. rateLimit   — per-API-key sliding window, sets X-RateLimit-* headers.
//   5. idempotency — enforces Idempotency-Key on state-changing methods.
//   6. auditLog    — logs POST/PUT/DELETE to audit_log table (fire-and-forget).
const v1 = new Hono<AppEnv>();
// REVIEW.md L-3: cap request body to 1 MB. Without this, an attacker can
// POST a multi-GB JSON payload and tie up a worker thread + memory.
v1.use(
  '*',
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: 'Request body too large (max 1 MB)' }, 413),
  }),
);
v1.use('*', ipRateLimit);
v1.use('*', auth);
v1.use('*', envGuard);
// REVIEW.md LOW-03: per-request key-revocation re-check. Hoisted out of
// the individual routers so that future contributors can't forget to
// mount it on a new state-changing surface. The middleware itself
// short-circuits on safe methods (GET/HEAD/OPTIONS) so GETs don't pay
// an extra DB round-trip — only POST/PUT/PATCH/DELETE re-query.
v1.use('*', revocationCheck);
v1.use('*', rateLimit);
v1.use('*', idempotency);
v1.use('*', auditLog);

// Agent-scope gate (see middleware/agentScope.ts). Agents are payment-only:
// every router below EXCEPT /payments rejects agent-bound API keys at the
// route layer (fail-closed). /payments still accepts agents and gates them
// at the service layer via authorizeAgentPayment, but its escrow + batch
// sub-paths apply requireNotAgent per-route inside payments.ts. Mounted
// here, before the routers, so every new non-payment surface inherits the
// gate by default — adding a future router that should accept agents is
// the explicit-opt-in path.
v1.use('/accounts/*', requireNotAgent);
v1.use('/agents/*', requireNotAgent);
v1.use('/tokens/*', requireNotAgent);
v1.use('/credentials/*', requireNotAgent);
v1.use('/permissions/*', requireNotAgent);
v1.use('/domains/*', requireNotAgent);
v1.use('/dex/*', requireNotAgent);
v1.use('/webhooks/*', requireNotAgent);

v1.route('/accounts', accountsRoute);
v1.route('/agents', agentsRoute);
v1.route('/tokens', tokensRoute);
v1.route('/credentials', credentialsRoute);
v1.route('/permissions', permissionsRoute);
v1.route('/domains', domainsRoute);
v1.route('/payments', paymentsRoute);
v1.route('/dex', dexRoute);
v1.route('/webhooks', webhooksRoute);
v1.route('/dashboard', dashboardRoute);

app.route('/v1', v1);

const port = Number(process.env.API_PORT ?? 3000);
logger.info({ port }, 'RailForge API starting');

// REVIEW.md M-1: thread Bun's `server` into Hono's env so middleware can
// call `server.requestIP(request)` to get the socket peer IP. Used by
// the trustedProxy helper to validate forwarded headers. On runtimes that
// don't pass `server` (test harness), env.server is undefined and the
// helper falls back to 'unknown' — conservative when the allowlist is on.
export default {
  port,
  // biome-ignore lint/suspicious/noExplicitAny: Bun runtime types aren't imported here
  fetch: (req: Request, server: any) => app.fetch(req, { server }),
};
