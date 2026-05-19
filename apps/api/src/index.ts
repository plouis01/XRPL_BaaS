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
import { createX402Middleware } from './middleware/x402.ts';
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
import x402Route from './routes/x402.ts';
import x402DemoRoute from './routes/x402Demo.ts';
import type { AppEnv } from './types.ts';

// Process-level diagnostics. We intentionally do NOT swallow uncaughtException
// — letting the process crash is the right recovery, because:
//   1. fly.toml has `[[restart]] policy='always' max_retries=0`, so a fresh
//      Bun comes up in <1 s.
//   2. Tolerating the throw keeps the broken postgres pool alive in memory.
//      Subsequent requests then hand-out the same dead connections, queries
//      hang server-side, and the request handler never returns — which
//      manifests as Cloudflare 502s + dashboard infinite spinners. We
//      learned this the hard way (see git log around May 8 2026).
//   3. The defenses against the stale-socket case live deeper:
//        - server-side `statement_timeout: 8000` in packages/db/src/client.ts
//          (queries return cleanly instead of hanging),
//        - aggressive `idle_timeout: 30` + `max_lifetime: 300` (sockets get
//          rotated before they go stale),
//        - `[[restart]]` (if a hard crash slips through, we recover fast).
//
// All this handler does now is log the crash so we can see what hit.
process.on('uncaughtException', (err: Error) => {
  logger.error(
    { err: err?.message ?? String(err), stack: err?.stack },
    'uncaughtException — process will exit',
  );
  throw err;
});
process.on('unhandledRejection', (reason) => {
  logger.error(
    { reason: reason instanceof Error ? reason.message : String(reason) },
    'unhandledRejection',
  );
});

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

// POST /v1/dashboard/signup mints a fresh testnet client + API key from
// the login UI. By default it's gated to non-production (so it can't ship
// as a public-signup oracle on mainnet by accident), but it can be opted
// into in production by setting `RAILFORGE_ALLOW_SIGNUP=1` — useful for
// early-access / testnet beta deployments where we want anyone with the
// dashboard URL to be able to mint a key.
//
// Even when enabled in production:
//   - The route mints `rf_test_` keys ONLY (testnet, hardcoded). Mainnet
//     access still requires manual provisioning.
//   - The pre-auth IP rate limiter caps spam.
//   - There's no email verification or captcha — accepting that surface
//     for testnet is the trade-off; do not enable on mainnet without
//     adding those defenses.
//
// A real signup flow (email verification, captcha, plan selection) is
// still deferred — this is a beta-shaped feature flag, not a long-term
// solution. Mirrors the `RAILFORGE_ALLOW_MAINNET` opt-in pattern.
const signupEnabled =
  process.env.NODE_ENV !== 'production' || process.env.RAILFORGE_ALLOW_SIGNUP === '1';
if (signupEnabled) {
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

// SPRINT_10_PLAN.md §4.6 — x402 demo mount. Gated by X402_DEMO_PAYEE so
// production deploys that don't want the dogfood surface stay off the
// internet. When the env var is set, mounts an x402-gated sub-app at
// /v1/x402-demo/* — the actual route handler (POST /echo) lands in Day 4.
//
// The middleware chain here intentionally does NOT include `auth`. Per
// the protocol, payment IS authentication. ipRateLimit still applies as
// a defense-in-depth IP bucket for the 402-issuance hot path.
if (process.env.X402_DEMO_PAYEE) {
  const x402DemoRoot = new Hono<AppEnv>();
  x402DemoRoot.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: 'Request body too large' }, 413),
    }),
  );
  x402DemoRoot.use('*', ipRateLimit);
  x402DemoRoot.use(
    '*',
    createX402Middleware({
      // Mode A: hardcoded quote from env. payee + asset + amount are
      // operational config, not user input. asset defaults to XRP;
      // amount to 10000 drops (0.01 XRP) — see SPRINT_10_PLAN §4.6.
      resolveRoute: async (_path) => ({
        payeeAddress: process.env.X402_DEMO_PAYEE ?? '',
        asset: process.env.X402_DEMO_ASSET ?? 'XRP',
        amount: process.env.X402_DEMO_AMOUNT ?? '10000',
        clientId: null,
      }),
      facilitatorVerifyUrl: process.env.X402_FACILITATOR_VERIFY_URL,
    }),
  );
  // Echo handler — POST /echo. The x402 middleware above gates every
  // path under /v1/x402-demo/*, so the handler only fires on a verified
  // X-PAYMENT.
  x402DemoRoot.route('/', x402DemoRoute);
  app.route('/v1/x402-demo', x402DemoRoot);
  logger.info('x402 demo route mounted at /v1/x402-demo');
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
// x402 management surface — verify + routes CRUD. Agent-bound keys have
// no business managing their tenant's gated routes; payments are the
// only agent-permitted surface.
v1.use('/x402/*', requireNotAgent);

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
v1.route('/x402', x402Route);

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
// `hostname: '0.0.0.0'` is required on Fly.io: the platform's edge proxy
// connects to the machine via the container's eth0 IPv4 address (172.x).
// Bun's default bind is 127.0.0.1 (loopback only), which makes the machine
// unreachable from outside the container — TCP-level "connection refused".
// IPv6 ('::') doesn't dual-stack on Fly's container (bindv6only=1), so we
// pick IPv4 explicitly. Local dev is unaffected.
export default {
  port,
  hostname: '0.0.0.0',
  // biome-ignore lint/suspicious/noExplicitAny: Bun runtime types aren't imported here
  fetch: (req: Request, server: any) => app.fetch(req, { server }),
};
