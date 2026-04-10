---
title: Tokens
description: Issue and manage fungible tokens on XRPL.
---

## Create token

```http
POST /v1/tokens
```

Issues a new fungible token. MPT (Multi-Purpose Token) is the default; trust lines are opt-in.

### Request body

| Field             | Type                 | Default | Description                         |
| ----------------- | -------------------- | ------- | ----------------------------------- |
| `issuer`          | string               | —       | Issuer XRPL address (required)      |
| `type`            | `mpt` \| `trustline` | `mpt`   | Token primitive                     |
| `currency_code`   | string               | —       | 1-40 character code (required)      |
| `transfer_fee`    | integer              | `0`     | Basis points (0-50000)              |
| `clawback`        | boolean              | `true`  | Enable clawback                     |
| `freeze_enabled`  | boolean              | `true`  | Enable freeze                       |
| `max_supply`      | string               | —       | Maximum supply (decimal)            |
| `metadata`        | object               | —       | Key/value metadata                  |
| `trustline_limit` | string               | —       | Required when `type` is `trustline` |

### Response `202 Accepted`

```json
{
  "id": "uuid",
  "issuer_address": "rXXX...",
  "token_type": "mpt",
  "currency_code": "USD",
  "mpt_issuance_id": null,
  "transfer_fee": 0,
  "clawback": true,
  "freeze_enabled": true,
  "max_supply": null,
  "status": "queued",
  "tx_id": "uuid",
  "created_at": "2025-01-01T00:00:00.000Z"
}
```

The `mpt_issuance_id` is backfilled after the transaction validates on-ledger.

## Transfer tokens

```http
POST /v1/tokens/:id/transfer
```

Transfer tokens from the issuer to a holder.

### Request body

| Field             | Type    | Description                  |
| ----------------- | ------- | ---------------------------- |
| `destination`     | string  | Recipient XRPL address       |
| `amount`          | string  | Amount to transfer (decimal) |
| `destination_tag` | integer | Optional                     |

### Response `202 Accepted`

```json
{ "tx_id": "uuid", "status": "queued" }
```

## Freeze token

```http
PUT /v1/tokens/:id/freeze
```

Freeze or unfreeze a token issuance (MPT only).

### Request body

| Field      | Type    | Default | Description                          |
| ---------- | ------- | ------- | ------------------------------------ |
| `holder`   | string  | —       | Specific holder to freeze (optional) |
| `unfreeze` | boolean | `false` | Set to `true` to unfreeze            |

## Clawback tokens

```http
PUT /v1/tokens/:id/clawback
```

Reclaim tokens from a holder. Requires clawback to be enabled on the token.

### Request body

| Field    | Type   | Description                  |
| -------- | ------ | ---------------------------- |
| `holder` | string | Holder XRPL address          |
| `amount` | string | Amount to clawback (decimal) |
