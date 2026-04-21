import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { logger } from './logger.ts';
import { auditLog } from './middleware/auditLog.ts';
import { auth } from './middleware/auth.ts';
import { corsMiddleware } from './middleware/cors.ts';
import { envGuard } from './middleware/envGuard.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import { idempotency } from './middleware/idempotency.ts';
import { ipRateLimit } from './middleware/ipRateLimit.ts';
import { rateLimit } from './middleware/rateLimit.ts';
import accountsRoute from './routes/accounts.ts';
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
v1.use('*', rateLimit);
v1.use('*', idempotency);
v1.use('*', auditLog);

v1.route('/accounts', accountsRoute);
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
