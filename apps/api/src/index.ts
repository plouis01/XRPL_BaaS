import { Hono } from 'hono';
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

app.route('/v1', v1);

const port = Number(process.env.API_PORT ?? 3000);
logger.info({ port }, 'RailForge API starting');

export default {
  port,
  fetch: app.fetch,
};
