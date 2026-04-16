// Trusted-proxy allowlist for forwarded-IP headers.
//
// REVIEW.md M-1 fix: previously, `ipRateLimit.ts` and `auth.ts` read
// `CF-Connecting-IP` / `X-Forwarded-For` from every request without
// checking who set them. An attacker talking directly to the API
// could forge these headers to rotate their apparent IP on every
// request, completely bypassing the pre-auth IP bucket.
//
// Design:
//   - `TRUSTED_PROXY_IPS` — comma-separated list of exact proxy IPs
//     (e.g. your Cloudflare front-end addresses, or a load-balancer's
//     internal IP).
//   - If UNSET: the middleware keeps the current "trust headers as-is"
//     behavior. This keeps dev + CI working without config, and it's
//     the only backward-compat we need — prod deployments MUST set
//     the env var.
//   - If SET: forwarded headers are honored ONLY when the socket
//     peer IP is in the list. Otherwise the peer IP is returned
//     directly, making header forgery a no-op.
//
// Not in scope for this sprint:
//   - CIDR ranges (could be added by swapping the Set lookup for a
//     proper range check — Cloudflare's IP list has ~20 ranges).
//   - IPv6 canonicalization (addresses are compared as-is).
//
// The peer IP comes from Bun's `server.requestIP()` — threaded through
// in `apps/api/src/index.ts` as `c.env.server`. On runtimes that don't
// expose it (unit test harness), we fall back to 'unknown' which is
// conservative: when the env var is set, an 'unknown' peer will NEVER
// be in the allowlist, so forwarded headers are ignored.

import type { Context } from 'hono';

let trustedProxies: Set<string> | null | undefined;

/**
 * Parse `TRUSTED_PROXY_IPS` once and cache. `null` → feature disabled
 * (env var unset or empty). `Set<string>` → enforce the allowlist.
 */
function getTrustedProxies(): Set<string> | null {
  if (trustedProxies !== undefined) return trustedProxies;
  const raw = process.env.TRUSTED_PROXY_IPS;
  if (!raw || raw.trim().length === 0) {
    trustedProxies = null;
    return null;
  }
  trustedProxies = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  return trustedProxies;
}

/**
 * Reset the parsed cache. Only used by tests that mutate
 * `process.env.TRUSTED_PROXY_IPS` between cases.
 */
export function resetTrustedProxyCache(): void {
  trustedProxies = undefined;
}

/**
 * Extract the socket peer IP from Hono's runtime bindings. Bun exposes
 * `server.requestIP(request)` which returns { address, family, port }.
 * Other runtimes may not expose this — we return undefined and the
 * caller decides how to degrade.
 */
function peerIpFromContext(c: Context): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: c.env shape depends on runtime
  const env = c.env as any;
  const server = env?.server;
  if (server && typeof server.requestIP === 'function') {
    try {
      const info = server.requestIP(c.req.raw);
      if (info && typeof info.address === 'string' && info.address.length > 0) {
        return info.address;
      }
    } catch {
      // Runtime threw — fall through to undefined.
    }
  }
  return undefined;
}

/**
 * Return the client IP for rate limiting / audit logging, respecting
 * the trusted-proxy allowlist.
 *
 *   - Env unset → CF-Connecting-IP → XFF[0] → peer IP → 'unknown'
 *     (backward-compatible legacy behavior)
 *   - Env set   → if peer IP is trusted: use forwarded headers
 *                 if peer IP is NOT trusted: use peer IP directly
 *                 if peer IP is unknown: use 'unknown' (ignore headers)
 */
export function getClientIp(c: Context): string {
  const trusted = getTrustedProxies();
  const peerIp = peerIpFromContext(c);

  if (trusted !== null) {
    // Feature enabled. Only honor forwarded headers from a trusted peer.
    if (peerIp !== undefined && trusted.has(peerIp)) {
      const cfIp = c.req.header('cf-connecting-ip');
      if (cfIp) return cfIp;
      const xff = c.req.header('x-forwarded-for');
      if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
      }
      // Trusted peer but no forwarded header — use the peer itself.
      return peerIp;
    }
    // Untrusted (or unknown) peer — forwarded headers are ignored.
    return peerIp ?? 'unknown';
  }

  // Feature disabled — legacy behavior.
  const cfIp = c.req.header('cf-connecting-ip');
  if (cfIp) return cfIp;
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return peerIp ?? 'unknown';
}
