---
title: Webhooks
description: Subscribe to transaction and compliance events via signed HTTP callbacks.
---

RailForge pushes state changes to your application as HMAC-signed POSTs to URLs you register. Every delivery is retried on transient failure and carries three headers (`X-RailForge-Signature`, `X-RailForge-Timestamp`, `X-RailForge-Webhook-Version`) that together authenticate the body and bound the replay window.

## Event types

A single endpoint can subscribe to any subset of these nine events:

| Event                   | Fired by                           | Description                                                               |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `transaction.validated` | `txConfirmer` (internal) + indexer | A tx you submitted validated on-ledger with `tesSUCCESS`                  |
| `transaction.failed`    | `txConfirmer` (internal) + indexer | A tx you submitted terminally failed (`tec*` / LastLedgerSequence expiry) |
| `credential.issued`     | indexer                            | A credential was issued to a managed account (incl. by external issuers)  |
| `credential.accepted`   | indexer                            | The subject accepted a credential                                         |
| `credential.revoked`    | indexer                            | A credential was revoked via `CredentialDelete`                           |
| `credential.expiring`   | `credentialExpiry` sweep           | A credential is ≤ 7 days from `expires_at`                                |
| `domain.created`        | indexer                            | A permissioned domain was created on-chain                                |
| `domain.updated`        | indexer                            | A domain's `accepted_credentials` list changed                            |
| `domain.deleted`        | indexer                            | A domain was deleted                                                      |

The `transaction.*` events are de-duplicated between the worker and the indexer — you receive exactly one delivery per validated tx even though both components observe it.

## Create webhook endpoint

```http
POST /v1/webhooks/endpoints
```

Registers a new webhook endpoint. The signing secret (`whsec_…`) is returned **only in this response** — store it securely. If you lose it, use the rotate endpoint below.

### Request body

| Field    | Type     | Description                                                                     |
| -------- | -------- | ------------------------------------------------------------------------------- |
| `url`    | string   | HTTPS URL to receive webhook POSTs. Must be publicly routable (no private IPs). |
| `events` | string[] | One or more of the nine event types listed above.                               |

### Response `201 Created`

```json
{
  "id": "ep_5f9e1a2c...",
  "url": "https://your-app.com/webhooks/railforge",
  "events": ["transaction.validated", "credential.issued"],
  "is_active": true,
  "secret": "whsec_2d8f...7b3c",
  "created_at": "2026-04-22T12:00:00.000Z"
}
```

## List webhook endpoints

```http
GET /v1/webhooks/endpoints
```

Returns all endpoints for the authenticated client. Secrets are **never** returned on this read path.

### Response `200 OK`

```json
{
  "data": [
    {
      "id": "ep_5f9e1a2c...",
      "url": "https://your-app.com/webhooks/railforge",
      "events": ["transaction.validated"],
      "is_active": true,
      "created_at": "2026-04-22T12:00:00.000Z"
    }
  ]
}
```

## Rotate endpoint secret

```http
POST /v1/webhooks/endpoints/:id/rotate-secret
```

Generates a fresh `whsec_` and returns it **once**. The old secret is discarded immediately — in-flight deliveries signed with the old secret will fail verification on your receiver, so coordinate the cutover with a brief tolerance window in your verification code.

### Response `200 OK`

```json
{
  "id": "ep_5f9e1a2c...",
  "secret": "whsec_newsecret..."
}
```

## Delete webhook endpoint

```http
DELETE /v1/webhooks/endpoints/:id
```

### Response `204 No Content`

## Delivery headers

Every POST includes these three headers:

| Header                        | Value                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `X-RailForge-Signature`       | Lowercase hex HMAC-SHA256 digest of `<timestamp>.<body>` with the endpoint secret as the key.                          |
| `X-RailForge-Timestamp`       | Unix seconds at the moment of delivery (regenerated on every retry).                                                   |
| `X-RailForge-Webhook-Version` | Scheme version. Currently `"1"`. Read this first so you can dispatch to the right verifier if the scheme ever evolves. |

### Body shape

```json
{
  "id": "whd_6c2b1e...",
  "type": "transaction.validated",
  "data": {
    "tx_id": "tx_7c9d...",
    "tx_hash": "ABC123...",
    "result_code": "tesSUCCESS",
    "ledger_index": 91234567
  }
}
```

## Verifying webhook signatures

Reconstruct the signing input as `timestamp + "." + body` — the raw bytes you received, not a re-serialization of the parsed JSON. Compare HMACs with a constant-time equality check. Reject any request older than 5 minutes to bound replay risk.

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a RailForge webhook v1 delivery.
 *
 * @param rawBody   the exact request body bytes (before parsing)
 * @param headers   a case-insensitive lookup for the request headers
 * @param secret    the endpoint secret from webhooks.create (whsec_…)
 * @param toleranceSeconds  max acceptable age of the timestamp (default 300)
 */
function verifyWebhook(
  rawBody: string,
  headers: { get(name: string): string | null },
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const version = headers.get("x-railforge-webhook-version");
  if (version !== "1") return false;

  const timestamp = headers.get("x-railforge-timestamp");
  const signature = headers.get("x-railforge-signature");
  if (!timestamp || !signature) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### Common verification pitfalls

- **Re-serializing the JSON body.** Your framework may parse `req.body` into an object. Always hash the _raw_ bytes — `Buffer.toString('utf8')` the incoming stream yourself before any `JSON.parse`.
- **Ignoring the timestamp.** Without the 5-minute window check, a stolen signed delivery can be replayed forever.
- **Non-constant-time string compare.** `a === b` on a signature string leaks timing; use `crypto.timingSafeEqual` as above.

## Delivery behavior

- **Retry schedule:** 5 attempts at 5s / 10s / 20s / 40s / 80s (exponential backoff, total ~155s).
- **Success:** any 2xx HTTP status. Your endpoint should return 2xx as soon as it has persisted the delivery ID — do not block on downstream side-effects.
- **Non-retryable:** 4xx (other than 429) marks the delivery failed immediately. Returning 400 to a RailForge webhook is a contract error; we do not retry it.
- **Retryable:** 5xx, 429, or any network error (DNS, TCP, TLS, timeout). The worker throws and BullMQ reschedules.
- **Redirects are not followed** — configure your webhook URL to point at the canonical endpoint. A 3xx response marks the delivery failed.
- **SSRF guard:** each delivery resolves the hostname and validates every returned A/AAAA record against private/reserved IP ranges. A URL that resolves to loopback, RFC 1918, link-local, or IPv4-mapped-IPv6 hex is refused at delivery time, regardless of how it looked at registration. This blocks DNS rebinding attacks; it also means localhost/`127.0.0.1` URLs do not work — expose a public tunnel (ngrok, Cloudflare Tunnel) for local development.
- **Failed deliveries** are recorded in `webhook_deliveries` with attempt count, response code, and last error; visible via the dashboard.

## Idempotency on the receiver side

We may re-deliver the same event after a 5xx. De-dupe on `body.id` (the webhook delivery UUID) — that value is stable across retries. Do **not** de-dupe on `body.data.tx_id` because the same tx can legitimately drive multiple event types (e.g. `transaction.validated` + `credential.issued` for the same CredentialCreate).
