---
title: Accounts
description: Create and manage XRPL accounts.
---

## Create account

```http
POST /v1/accounts
```

Creates a funded XRPL account. The account is funded asynchronously from the platform treasury.

### Request body

| Field               | Type                      | Default | Description                   |
| ------------------- | ------------------------- | ------- | ----------------------------- |
| `label`             | string                    | —       | Optional human-readable label |
| `custody_mode`      | `semi` \| `non_custodial` | `semi`  | Key custody model             |
| `fund_amount`       | string                    | `"10"`  | XRP to fund (drops)           |
| `multisign`         | object                    | —       | Optional multi-sign config    |
| `multisign.quorum`  | integer                   | —       | Required signer weight        |
| `multisign.signers` | array                     | —       | `[{address, weight}]`         |

### Response `201 Created`

```json
{
  "id": "uuid",
  "address": "rXXX...",
  "regular_key": null,
  "custody_mode": "semi",
  "label": "my-account",
  "is_funded": false,
  "reserve_balance": "0",
  "funding_tx_id": "uuid",
  "created_at": "2025-01-01T00:00:00.000Z"
}
```

## Get account

```http
GET /v1/accounts/:address
```

Returns account details by XRPL address.

### Response `200 OK`

Same shape as create response.

## Configure signers

```http
PUT /v1/accounts/:address/signers
```

Configures multi-sign signer list. Returns `202 Accepted` with a queued transaction.

### Request body

| Field     | Type    | Description                                     |
| --------- | ------- | ----------------------------------------------- |
| `quorum`  | integer | Required total signer weight (0 to remove list) |
| `signers` | array   | `[{address, weight}]` entries                   |

### Response `202 Accepted`

```json
{ "tx_id": "uuid", "status": "queued" }
```

## Rotate regular key

```http
POST /v1/accounts/:address/rotate-key
```

Rotates the regular key. Pass `null` to remove it.

### Request body

| Field         | Type           | Description                                |
| ------------- | -------------- | ------------------------------------------ |
| `regular_key` | string \| null | New regular key address, or null to remove |

### Response `202 Accepted`

```json
{ "tx_id": "uuid", "status": "queued" }
```

## Delete account

```http
DELETE /v1/accounts/:address
```

Deletes an XRPL account and sends remaining XRP to the destination.

### Request body

| Field             | Type    | Description                               |
| ----------------- | ------- | ----------------------------------------- |
| `destination`     | string  | XRPL address to receive remaining balance |
| `destination_tag` | integer | Optional destination tag                  |

### Response `202 Accepted`

```json
{ "tx_id": "uuid", "status": "queued" }
```
