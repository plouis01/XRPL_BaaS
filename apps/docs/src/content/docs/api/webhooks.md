---
title: Webhooks
description: Subscribe to transaction events via webhooks.
---

## Create webhook endpoint

```http
POST /v1/webhooks/endpoints
```

Registers a new webhook endpoint. The signing secret is returned only in this response — store it securely.

### Request body

| Field    | Type   | Description                                                |
| -------- | ------ | ---------------------------------------------------------- |
| `url`    | string | HTTPS URL to receive webhook POSTs                         |
| `events` | array  | Event types: `transaction.validated`, `transaction.failed` |

### Response `201 Created`

```json
{
  "id": "uuid",
  "url": "https://your-app.com/webhooks",
  "events": ["transaction.validated"],
  "is_active": true,
  "secret": "whsec_abc123...",
  "created_at": "2025-01-01T00:00:00.000Z"
}
```

## List webhook endpoints

```http
GET /v1/webhooks/endpoints
```

Returns all webhook endpoints for the authenticated client. Secrets are not included.

### Response `200 OK`

```json
{
  "data": [
    {
      "id": "uuid",
      "url": "https://your-app.com/webhooks",
      "events": ["transaction.validated"],
      "is_active": true,
      "created_at": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

## Delete webhook endpoint

```http
DELETE /v1/webhooks/endpoints/:id
```

### Response `204 No Content`

No body.

## Verifying webhook signatures

Every webhook delivery includes an `X-RailForge-Signature` header containing an HMAC-SHA256 signature of the request body, signed with your endpoint secret.

```typescript
import { createHmac } from "node:crypto";

function verifyWebhook(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return expected === signature;
}
```

## Delivery behavior

- Webhooks are delivered with exponential backoff: 5s, 10s, 20s, 40s, 80s (5 attempts)
- A delivery is considered successful on any 2xx HTTP status
- After 5 failed attempts, the delivery is marked as failed
- Failed deliveries are logged and visible in the dashboard
