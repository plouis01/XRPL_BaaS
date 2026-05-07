import { checkMigrationDrift } from '@railforge/db';
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
import dashboardSignupRoute from './routes/dashboardSignup.ts';
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

// Dev-only: POST /v1/dashboard/signup mints a fresh testnet client + API
// key from the login UI. Hard-gated on NODE_ENV !== 'production' so the
// route is literally not registered when shipped. A real signup flow
// (email verification, captcha) is deferred.
if (process.env.NODE_ENV !== 'production') {
  const signupRoot = new Hono<AppEnv>();
  signupRoot.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: 'Request body too large' }, 413),
    }),
  );
  signupRoot.use('*', ipRateLimit);
  signupRoot.route('/', dashboardSignupRoute);
  app.route('/v1/dashboard/signup', signupRoot);
}

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
// /dashboard/* is agent-blocked too: POST /dashboard/keys mints a fresh
// API key, and without this guard an agent-bound caller could mint a
// non-bound key (omit body.agent_id) and escalate to full-tenant. The
// read-only GETs are blocked too — an agent has no business enumerating
// the tenant's transactions, credentials, or other agents.
v1.use('/dashboard/*', requireNotAgent);

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

// Migration drift check. We had an outage in May 2026 where a manual
// edit to packages/db/src/migrations/meta/_journal.json desynchronized
// drizzle-kit's bookkeeping — `bun run db:migrate` reported success but
// silently no-op'd a pending migration, and the API booted against a
// schema missing a column that every payment-service insert needed. The
// production-side symptom was a generic 500. This check logs the drift
// at boot so the next pair of eyes spots it before traffic starts. We
// log-and-continue rather than fail the boot — apps with a long-running
// connection pool and a legitimate journal-trailing-DB scenario (newer
// API code rolling out before the migrate job lands) shouldn't be hard-
// blocked. Mainnet rollout can escalate to fatal when warranted.
//
// Best-effort: if the check itself throws (DATABASE_URL missing, journal
// file unreadable in a bundled deploy), swallow and keep booting.
void checkMigrationDrift()
  .then((result) => {
    if (result.drift) {
      logger.warn(
        {
          journalCount: result.journalCount,
          appliedCount: result.appliedCount,
          missingTags: result.missingTags,
        },
        'migration drift detected: journal has more entries than DB has applied. Run `bun run db:migrate` or check for a manually-edited journal.',
      );
    } else {
      logger.info({ migrations: result.appliedCount }, 'migration drift check OK');
    }
  })
  .catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'migration drift check skipped (non-fatal)',
    );
  });

// REVIEW.md M-1: thread Bun's `server` into Hono's env so middleware can
// call `server.requestIP(request)` to get the socket peer IP. Used by
// the trustedProxy helper to validate forwarded headers. On runtimes that
// don't pass `server` (test harness), env.server is undefined and the
// helper falls back to 'unknown' — conservative when the allowlist is on.
// `hostname: '0.0.0.0'` is required for Fly.io: the platform's proxy
// reaches the machine via 0.0.0.0:<internal_port>, not 127.0.0.1. Bun's
// default bind is localhost, which makes the machine unreachable from
// outside the container. This is harmless in local dev (still bound on
// the loopback alias of 0.0.0.0).
export default {
  port,
  hostname: '0.0.0.0',
  // biome-ignore lint/suspicious/noExplicitAny: Bun runtime types aren't imported here
  fetch: (req: Request, server: any) => app.fetch(req, { server }),
};
