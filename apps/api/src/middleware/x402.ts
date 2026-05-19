// x402 HTTP-402 gating middleware. SPRINT_10_PLAN.md §4.4.
//
// Factory pattern — call `createX402Middleware(config)` per mount point.
// Two consumers:
//
//   1. Mode A: a hardcoded route (e.g. /v1/x402-demo/echo) that pays into
//      the RailForge treasury. Config supplies the payee + asset + price.
//   2. Mode B (future / SDK): a client's own server using a DB-backed
//      route registry. Config supplies an async `resolveRoute(path)` that
//      hits x402Routes. The middleware itself doesn't care which path it
//      came from — it just asks for `(payee, asset, amount)`.
//
// Middleware chain when mounted (REPLACES `auth` — payment IS the auth):
//
//     ipRateLimit → x402 → envGuard → rateLimit → idempotency → auditLog
//
// `revocationCheck` is still mounted globally on /v1/* but short-circuits
// on safe methods AND when `clientId` is unset (an anonymous x402-paid
// caller has no key to revoke).
//
// Behavior:
//
//   - No `X-PAYMENT` header:
//       resolve route → mint intent → 402 JSON body
//   - `X-PAYMENT` present:
//       decode → verifyPayment → on ok: c.set('x402Intent', intent),
//                                        next() (route handler runs)
//                                on fail: mint a FRESH intent + 402 + reason
//
// Rate-limit: the 402-issuance path is rate-limited per source IP via a
// dedicated Redis sliding window (separate namespace from `ipRateLimit`
// so it doesn't budget against the per-IP ceiling). A misconfigured or
// adversarial client that hammers a gated route without ever paying
// would otherwise flood `x402_intents` with garbage rows.

import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger.ts';
import { getRedis } from '../redis.ts';
import { type X402Intent, createIntent } from '../services/x402Intent.service.ts';
import { verifyPayment } from '../services/x402Verify.service.ts';
import type { AppEnv } from '../types.ts';
import { getClientIp } from './trustedProxy.ts';

// xrpl-core helpers live in @railforge/xrpl-core. Imported lazily inside
// the middleware body so a test that mocks the module gets its mock
// honored.
import { decodePaymentHeader } from '@railforge/xrpl-core';

const log = logger.child({ component: 'x402-middleware' });

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Quote a gated route. Return null when the path isn't gated — the
 * middleware then 404s (instead of returning 402 for an unknown path,
 * which would leak the existence of gated routes the caller hasn't
 * registered).
 */
export interface X402RouteQuote {
  payeeAddress: string;
  /** Asset reference: `XRP` or `mpt:<48-hex>`. */
  asset: string;
  /** Smallest-unit decimal string (drops for XRP, raw MPT units otherwise). */
  amount: string;
  /** Mode-A: the RailForge client owning the route. Null in Mode B. */
  clientId?: string | null;
}

export interface X402MiddlewareConfig {
  resolveRoute: (path: string) => Promise<X402RouteQuote | null>;
  /** Default 30 intents/min/IP. */
  intentsPerMinutePerIp?: number;
  /** Override the public verifier URL emitted in 402 bodies (Mode B). */
  facilitatorVerifyUrl?: string;
}

// ── Internals ───────────────────────────────────────────────────────────────

const INTENT_RATE_WINDOW_MS = 60_000;
const INTENT_RATE_WINDOW_SECONDS = 60;
const DEFAULT_INTENT_RATE = 30;

/**
 * Per-IP sliding window for 402 issuance. Same algorithm as ipRateLimit
 * (zremrangebyscore + zadd + zcard + expire pipeline) but on a dedicated
 * namespace so the budgets don't share. Returns `true` to block.
 *
 * Fails OPEN on Redis errors — losing the secondary IP budget is the same
 * blast-radius as losing the per-IP limiter; the call site logs the
 * degraded mode so ops can alert.
 */
async function intentRateLimitHit(ip: string, limit: number): Promise<boolean> {
  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - INTENT_RATE_WINDOW_MS;
  const key = `railforge:x402:intent_ip:${ip}`;
  const member = `${now}-${Math.random()}`;
  try {
    const pipe = redis.multi();
    pipe.zremrangebyscore(key, 0, windowStart);
    pipe.zadd(key, now, member);
    pipe.zcard(key);
    pipe.expire(key, INTENT_RATE_WINDOW_SECONDS);
    const result = await pipe.exec();
    if (!result) return false;
    const card = result[2];
    const count = card && typeof card[1] === 'number' ? card[1] : 0;
    return count > limit;
  } catch (err) {
    log.warn({ err, key }, 'x402 intent-rate redis error — failing open');
    return false;
  }
}

/**
 * Mint an intent for `(path, quote)` and shape it into the 402 response
 * body. Public-facing field names follow the protocol (snake_case keys
 * the SDK + remote facilitators expect), not the internal camelCase
 * representation.
 */
async function emit402(
  path: string,
  quote: X402RouteQuote,
  facilitatorVerifyUrl: string | undefined,
  reason: string | null,
): Promise<{ status: 402; body: Record<string, unknown> }> {
  const intent = await createIntent({
    resourcePath: path,
    payeeAddress: quote.payeeAddress,
    asset: quote.asset,
    amount: quote.amount,
    clientId: quote.clientId ?? null,
  });
  return {
    status: 402,
    body: {
      x402_version: 1,
      intent_id: intent.id,
      resource: path,
      payee: intent.payeeAddress,
      asset: quote.asset,
      amount: intent.amount,
      destination_tag: intent.destinationTag,
      expires_at: intent.expiresAt.toISOString(),
      ...(facilitatorVerifyUrl ? { facilitator_verify_url: facilitatorVerifyUrl } : {}),
      // Only set on a re-quote so the SDK can map machine-readable failure
      // reasons onto user-facing errors. Absent on the first 402.
      ...(reason ? { reason } : {}),
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a Hono middleware that gates the routes mounted under it with
 * x402. Each mount may pass a different `resolveRoute` — a Mode-A demo
 * uses a constant quote, a future Mode-B mount would hit x402Routes.
 */
export function createX402Middleware(config: X402MiddlewareConfig): MiddlewareHandler<AppEnv> {
  const intentRateLimit = config.intentsPerMinutePerIp ?? DEFAULT_INTENT_RATE;
  const facilitatorVerifyUrl = config.facilitatorVerifyUrl;

  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const quote = await config.resolveRoute(path);

    // 404 (not 402) on an unknown path so a probe can't enumerate gated
    // routes by triggering different reason strings.
    if (!quote) {
      return c.json({ error: 'Not found' }, 404);
    }

    const header = c.req.header('x-payment');

    // Path A — no header. Issue 402 with a fresh intent.
    if (!header) {
      if (await intentRateLimitHit(getClientIp(c), intentRateLimit)) {
        c.header('Retry-After', String(INTENT_RATE_WINDOW_SECONDS));
        return c.json(
          {
            error: 'Too many intent requests',
            retry_after_seconds: INTENT_RATE_WINDOW_SECONDS,
          },
          429,
        );
      }
      const { status, body } = await emit402(path, quote, facilitatorVerifyUrl, null);
      c.header('WWW-Authenticate', `X402 realm="${path}"`);
      return c.json(body, status);
    }

    // Path B — header present. Decode + verify.
    let decoded: { intentId: string; txHash: string };
    try {
      decoded = decodePaymentHeader(header);
    } catch (err) {
      log.info(
        { err: err instanceof Error ? err.message : String(err), path },
        'x402: malformed X-PAYMENT header',
      );
      if (await intentRateLimitHit(getClientIp(c), intentRateLimit)) {
        c.header('Retry-After', String(INTENT_RATE_WINDOW_SECONDS));
        return c.json(
          {
            error: 'Too many intent requests',
            retry_after_seconds: INTENT_RATE_WINDOW_SECONDS,
          },
          429,
        );
      }
      const { status, body } = await emit402(path, quote, facilitatorVerifyUrl, 'malformed_header');
      c.header('WWW-Authenticate', `X402 realm="${path}"`);
      return c.json(body, status);
    }

    const verifyResult = await verifyPayment(decoded.intentId, decoded.txHash);

    if (verifyResult.ok) {
      // Stash on context. Route handler may read intent.id / consumingTxHash
      // to mirror them on the response (e.g. an X-PAYMENT-RESPONSE header).
      c.set('x402Intent', verifyResult.intent as unknown as X402Intent);
      c.header('X-PAYMENT-INTENT-ID', verifyResult.intent.id);
      if (verifyResult.intent.consumingTxHash) {
        c.header('X-PAYMENT-TX-HASH', verifyResult.intent.consumingTxHash);
      }
      await next();
      return;
    }

    // Verification failed. Re-quote with a fresh intent (rate-limited).
    if (await intentRateLimitHit(getClientIp(c), intentRateLimit)) {
      c.header('Retry-After', String(INTENT_RATE_WINDOW_SECONDS));
      return c.json(
        {
          error: 'Too many intent requests',
          retry_after_seconds: INTENT_RATE_WINDOW_SECONDS,
        },
        429,
      );
    }
    log.info(
      { reason: verifyResult.reason, intentId: decoded.intentId, path },
      'x402: payment did not verify, re-quoting',
    );
    const { status, body } = await emit402(path, quote, facilitatorVerifyUrl, verifyResult.reason);
    c.header('WWW-Authenticate', `X402 realm="${path}"`);
    return c.json(body, status);
  };
}
