---
title: Authentication
description: How to authenticate with the RailForge API.
---

## API keys

All requests to `/v1/*` endpoints require an API key passed via the `X-Api-Key` header.

```bash
curl -H "X-Api-Key: rf_test_abc123..." https://api.testnet.railforge.dev/v1/accounts
```

### Key prefixes

| Prefix     | Environment          |
| ---------- | -------------------- |
| `rf_test_` | Testnet (sandbox)    |
| `rf_live_` | Mainnet (production) |

Keys are scoped to an environment. A testnet key cannot access mainnet resources and vice versa.

### Key management

Create and manage API keys through the [dashboard](/keys) or the API key management endpoints.

## Rate limiting

| Limit       | Scope                       |
| ----------- | --------------------------- |
| 300 req/min | Per IP (pre-auth)           |
| 100 req/min | Per API key (authenticated) |

Rate limit headers are included in every response:

- `X-RateLimit-Limit` — Maximum requests per window
- `X-RateLimit-Remaining` — Remaining requests in current window
- `X-RateLimit-Reset` — Seconds until the window resets

## Idempotency

All state-changing requests (`POST`, `PUT`, `DELETE`) require an `Idempotency-Key` header:

```bash
curl -X POST \
  -H "X-Api-Key: rf_test_abc123..." \
  -H "Idempotency-Key: my-unique-key-123" \
  -H "Content-Type: application/json" \
  -d '{"label": "test"}' \
  https://api.testnet.railforge.dev/v1/accounts
```

The SDK generates idempotency keys automatically.
