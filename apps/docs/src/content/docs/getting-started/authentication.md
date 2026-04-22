---
title: Authentication
description: API keys, cookie sessions, rate limiting, idempotency, and revocation.
---

Every request to `/v1/*` must identify an authenticated client. RailForge accepts two credential carriers — a header for server-to-server clients and a cookie for the first-party dashboard — and runs the same `auth → envGuard → revocationCheck → rateLimit → idempotency → auditLog` middleware chain for both.

## API keys

### Format

| Prefix     | Environment          |
| ---------- | -------------------- |
| `rf_test_` | Testnet (sandbox)    |
| `rf_live_` | Mainnet (production) |

Keys are scoped to an environment. A testnet key cannot authenticate against a mainnet-configured API node and vice versa — `envGuard` returns 403 on a mismatch.

Keys are hashed with HMAC-SHA256 + a server-side pepper before any lookup. Only the first 8 characters (`rf_test_` or `rf_live_`) are ever logged. RailForge cannot recover a lost key — issue a new one and revoke the old.

### Server-to-server: `X-Api-Key`

```bash
curl -H "X-Api-Key: rf_test_abc123..." \
     https://api.testnet.railforge.dev/v1/accounts/rXXX...
```

### First-party dashboard: cookie session

The dashboard hands the API key to the server **once** via `POST /v1/dashboard/session`. On success the server returns `204 No Content` plus a `Set-Cookie: railforge_session=<key>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800` header. Every subsequent call uses `credentials: 'include'` so the browser attaches the cookie automatically — the key is never readable from JavaScript, closing the XSS-exfiltration vector.

```typescript
// One-time login.
await fetch("https://api.railforge.dev/v1/dashboard/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",
  body: JSON.stringify({ api_key: "rf_test_..." }),
});

// Subsequent authenticated call.
const res = await fetch("https://api.railforge.dev/v1/accounts/rXXX", {
  credentials: "include",
});
```

Logout clears the cookie with `DELETE /v1/dashboard/session`. It does **not** revoke the underlying API key.

> The cookie is `SameSite=Strict` — browsers refuse to send it on any cross-origin request. This is load-bearing for CSRF defense. If your integration needs a cross-site flow (OAuth callback, IdP-initiated redirect, embedded iframe) pair a downgrade with a CSRF double-submit token.

## Rate limiting

Two layers are always active on `/v1/*`.

| Layer         | Scope                    | Default                                        | Headers emitted                                                                       |
| ------------- | ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ipRateLimit` | Per source IP (pre-auth) | 300 req/min (configurable via `IP_RATE_LIMIT`) | 429 + `Retry-After` on overage                                                        |
| `rateLimit`   | Per API key (post-auth)  | 300 req/min (per-key `api_keys.rate_limit`)    | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Mode` |

`GET /v1/dex/orderbook/:base/:counter` and `GET /v1/dex/amm/:asset1/:asset2` additionally pass through a tighter per-key limiter at 30 req/min — these routes proxy free-tier-abusable rippled queries, so they're scoped separately.

If Redis is briefly unreachable the per-key limiter falls back to an in-process sliding window and emits `X-RateLimit-Mode: degraded`. Operators should alert on a sustained rise in this header.

## Key revocation

`revocationCheck` middleware is globally mounted on `/v1/*`. It short-circuits for safe methods (GET/HEAD/OPTIONS), then re-queries the `api_keys` row for every POST/PUT/PATCH/DELETE to confirm `is_active=true AND revoked_at IS NULL`. This closes the window between the auth-cache lookup and the actual state-changing handler — a key revoked mid-flight cannot submit a tx.

Revoked keys fail with `401 Unauthorized` and the generic message `"API key has been revoked"` — the same wire response as an unknown key, so revocation is not an enumeration oracle.

To revoke a key:

```http
POST /v1/dashboard/keys/:id/revoke
```

Idempotent; a revoked key returns `{ "id", "revoked": true }` on every call.

## Idempotency

All state-changing requests (`POST` / `PUT` / `PATCH` / `DELETE`) **require** an `Idempotency-Key` header of 1–256 characters. The middleware enforces it; requests without the header fail 400 before the handler runs.

```bash
curl -X POST \
  -H "X-Api-Key: rf_test_abc..." \
  -H "Idempotency-Key: create-account-2026-04-22-01" \
  -H "Content-Type: application/json" \
  -d '{"label": "treasury"}' \
  https://api.testnet.railforge.dev/v1/accounts
```

### Semantics

- **Cache:** the first 2xx response for `(client_id, method, normalized_path, idempotency_key)` is stored in Redis for 24 hours. Subsequent requests with the same key replay the exact response and include `X-Idempotent-Replay: true`.
- **Concurrency:** a short-lived (60 s) Redis lock bounds two concurrent requests with the same key. The loser gets `409 Conflict` with `{"error": "Idempotent request already in progress", "retry_after_seconds": 1}`.
- **Non-2xx:** 4xx and 5xx responses are **not** cached. Retrying a validation error re-runs the handler; you won't get stuck at 401 if you fix the cause.
- **Path normalization:** runs of `/` are collapsed and trailing slashes stripped before hashing. URL case is **preserved** — XRPL base58 addresses are case-sensitive, so `/accounts/rXxx` and `/accounts/rXXX` are different buckets.
- **Cross-tenant safety:** `client_id` is part of the cache key, so two clients never share a cache slot even if they happen to pick the same idempotency key.

The SDK generates idempotency keys automatically as `crypto.randomUUID()` on every call. If you send the same `Idempotency-Key` with different request bodies, you get the **cached first response** — idempotency is defined by the key, not the body.

## Spend policies

If you configure a spend policy row for your client (via an operator — not exposed on the public API), every XRP-denominated state-changing request runs through an atomic Redis counter that enforces both a per-tx limit and a rolling 24-hour limit. Non-XRP state-changing ops (MPT / issued-currency payments, token transfer / freeze / clawback, DEX offers, AMM deposit / withdraw) pass through a separate per-day count ceiling (default 5,000 ops/day, configurable via `TOKEN_OPS_DAILY_LIMIT`). Over-limit requests fail with `400` and a `SpendPolicyError` code (`per_tx_limit_exceeded` or `daily_limit_exceeded`).

## Error responses

| Status | Meaning                                                                           |
| ------ | --------------------------------------------------------------------------------- |
| 400    | Validation error (Zod), missing `Idempotency-Key`, schema failure                 |
| 401    | Invalid / missing / revoked API key                                               |
| 403    | Environment mismatch, cross-env key-mint, permission deny                         |
| 404    | Resource not found (or belongs to a different client — the response is identical) |
| 409    | Idempotency conflict (concurrent in-flight request with the same key)             |
| 413    | Request body too large (> 1 MB on `/v1/*`, > 64 KB on `/v1/dashboard/session`)    |
| 429    | Rate limit exceeded                                                               |
| 503    | Service unavailable (DB or upstream rippled refused)                              |

Error bodies are a single `{ "error": "…" }` string by default. In `NODE_ENV=development`, the error message may include additional detail; production responses are deliberately generic to avoid leaking schema / query internals.
