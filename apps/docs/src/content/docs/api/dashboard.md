---
title: Dashboard
description: Endpoints backing the first-party RailForge dashboard — session login, API key CRUD, resource listing by environment.
---

The `/v1/dashboard/*` routes back the React dashboard. They use the same auth chain as the rest of `/v1/*` plus the cookie-session helpers documented in [Authentication](/getting-started/authentication/). Most endpoints are read-only listings scoped to the authenticated client and filtered by environment (`testnet` / `mainnet`). The key-minting routes are the only state-changing surface here, and both are protected by the privilege-separation check from review finding HIGH-02.

## Session login

```http
POST /v1/dashboard/session
```

Validates an API key and sets an httpOnly `SameSite=Strict` Secure cookie carrying the key. The cookie expires after 7 days. See [Authentication › Cookie session](/getting-started/authentication/#first-party-dashboard-cookie-session) for the full flow.

### Request body

| Field     | Type   | Description                                                                                   |
| --------- | ------ | --------------------------------------------------------------------------------------------- |
| `api_key` | string | 10–256 chars. Validated via HMAC + active + not-revoked, same as the `X-Api-Key` header path. |

### Responses

| Status | Meaning                                                                  |
| ------ | ------------------------------------------------------------------------ |
| 204    | Cookie set. Subsequent calls use `credentials: 'include'`.               |
| 400    | Malformed body (Zod rejection).                                          |
| 401    | Unknown, inactive, or revoked key. Generic message (no enumeration).     |
| 413    | Body exceeds 64 KB (the sessionRoot has a tighter bodyLimit than `/v1`). |
| 503    | DB unreachable; retry.                                                   |

## Session logout

```http
DELETE /v1/dashboard/session
```

Clears the cookie. Does **not** revoke the underlying API key — use `POST /v1/dashboard/keys/:id/revoke` for that.

### Response `204 No Content`

## List API keys

```http
GET /v1/dashboard/keys?environment=testnet
```

Lists the authenticated client's API keys for the requested environment. Key secrets are **never** returned on this read path — they're only visible once, at creation time.

### Query params

| Param         | Type                   | Description                          |
| ------------- | ---------------------- | ------------------------------------ |
| `environment` | `testnet` \| `mainnet` | Required. Key environment to filter. |

### Response `200 OK`

```json
{
  "data": [
    {
      "id": "key_1a2f...",
      "prefix": "rf_test_",
      "environment": "testnet",
      "is_active": true,
      "created_at": "2026-04-22T12:00:00.000Z",
      "revoked_at": null
    }
  ]
}
```

## Create API key

```http
POST /v1/dashboard/keys
```

Mints a new API key for the authenticated client. The plaintext key is returned **once** in this response and never again — RailForge only stores the HMAC.

### Privilege separation (HIGH-02)

The new key's `environment` **must equal the caller's environment**. Cross-env minting (especially testnet → mainnet) returns 403 with a clear error. A tenant that legitimately needs a key for the other environment must obtain one through the normal onboarding flow, not by calling this endpoint with a key from the other environment.

### Request body

| Field         | Type                   | Description                          |
| ------------- | ---------------------- | ------------------------------------ |
| `environment` | `testnet` \| `mainnet` | Must match the caller's environment. |
| `label`       | string                 | Optional. 1–200 chars.               |

### Response `201 Created`

```json
{
  "id": "key_1a2f...",
  "prefix": "rf_test_",
  "environment": "testnet",
  "is_active": true,
  "created_at": "2026-04-22T12:00:00.000Z",
  "key": "rf_test_A1b2C3d4..."
}
```

> **Copy `key` out of this response immediately.** There is no endpoint that returns it again. If you lose it, revoke and create a replacement.

## Revoke API key

```http
POST /v1/dashboard/keys/:id/revoke
```

Flips `is_active=false` and stamps `revoked_at`. Idempotent — revoking an already-revoked key returns 200 with the same payload. The revocation propagates to all active sessions via the global `revocationCheck` middleware on the next state-changing call.

### Response `200 OK`

```json
{ "id": "key_1a2f...", "revoked": true }
```

## List transactions

```http
GET /v1/dashboard/transactions?network=testnet&limit=50
```

Returns the authenticated client's transaction history scoped to the selected network. The filter is coarse — it hides the whole client when they have no keys in the selected environment, and shows all rows otherwise. A per-row network column is a schema change deferred to the mainnet rollout.

### Query params

| Param     | Type                   | Default | Description |
| --------- | ---------------------- | ------- | ----------- |
| `network` | `testnet` \| `mainnet` | —       | Required.   |
| `limit`   | integer                | 50      | 1–200.      |

### Response `200 OK`

```json
{
  "data": [
    {
      "id": "tx_a1c3...",
      "tx_type": "Payment",
      "source_address": "rSrc...",
      "status": "validated",
      "tx_hash": "ABC123...",
      "result_code": "tesSUCCESS",
      "ledger_index": 91234567,
      "created_at": "2026-04-22T12:00:00.000Z",
      "confirmed_at": "2026-04-22T12:00:05.000Z"
    }
  ]
}
```

## List credentials

```http
GET /v1/dashboard/credentials?environment=testnet
```

Same shape as [`GET /v1/accounts/:address/credentials`](/api/accounts/#list-credentials-for-account) but scoped to the whole client, capped at 200 rows, ordered by `created_at DESC`.

## List domains

```http
GET /v1/dashboard/domains?environment=testnet
```

Returns up to 200 most recent permissioned domains owned by the client in the selected environment. Same `data` shape as [`GET /v1/domains/:id`](/api/domains/#get-domain).
