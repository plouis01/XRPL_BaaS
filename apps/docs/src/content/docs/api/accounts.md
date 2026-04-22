---
title: Accounts
description: Create, read, configure, and delete XRPL accounts.
---

## Create account

```http
POST /v1/accounts
```

Creates an XRPL account. The account is funded asynchronously from the platform treasury — the response returns with `is_funded: false` and a `funding_tx_id`. Poll `GET /v1/accounts/:address` until `is_funded` flips to `true` (~4 s under normal testnet conditions).

### Request body

| Field               | Type                      | Default | Description                                              |
| ------------------- | ------------------------- | ------- | -------------------------------------------------------- |
| `label`             | string                    | —       | Optional human-readable label                            |
| `custody_mode`      | `semi` \| `non_custodial` | `semi`  | Key custody model                                        |
| `fund_amount`       | string                    | `"10"`  | XRP amount sent from treasury (human decimal, not drops) |
| `multisign`         | object                    | —       | Optional multi-sign config applied after funding         |
| `multisign.quorum`  | integer                   | —       | Required total signer weight                             |
| `multisign.signers` | array                     | —       | 1–32 entries of `{ address, weight }`                    |

### Response `201 Created`

```json
{
  "id": "acc_7b2e...",
  "address": "rXXX...",
  "regular_key": null,
  "custody_mode": "semi",
  "label": "treasury",
  "is_funded": false,
  "reserve_balance": "0",
  "funding_tx_id": "tx_a1c3...",
  "created_at": "2026-04-22T12:00:00.000Z"
}
```

## Get account

```http
GET /v1/accounts/:address
```

Returns account details by XRPL address. Cross-tenant isolation: the query is scoped to the authenticated client, so a request for an address owned by another client returns 404.

### Response `200 OK`

Same shape as the create response.

## Get account balances (live)

```http
GET /v1/accounts/:address/balances
```

Live rippled snapshot. Queries `account_info` for XRP, `account_lines` for trust-line holdings, and `account_objects` filtered to `MPToken` for MPT holdings — no indexer lag.

### Response `200 OK`

```json
{
  "address": "rXXX...",
  "xrp_drops": "19988000",
  "trustlines": [
    { "currency": "USD", "issuer": "rIssuer...", "balance": "1000.00" }
  ],
  "mpts": [{ "mpt_issuance_id": "00000001A4...", "balance": "500" }]
}
```

If the account has not yet been funded on-ledger, `xrp_drops` is `"0"` and the arrays are empty.

## List credentials for account

```http
GET /v1/accounts/:address/credentials?limit=50&offset=0
```

Returns credentials where the account is the _subject_ (incoming credentials). Paginated; `limit` 1–1000 (default 50), `offset` ≥ 0 (default 0).

### Response `200 OK`

```json
{
  "data": [
    {
      "id": "cred_9a2f...",
      "issuer_address": "rIssuer...",
      "subject_address": "rXXX...",
      "credential_type": "4B5943",
      "status": "accepted",
      "expires_at": 788_745_600,
      "accepted_at": "2026-04-22T12:00:00.000Z",
      "created_at": "2026-04-22T11:00:00.000Z"
    }
  ],
  "pagination": { "limit": 50, "offset": 0, "total": 1 }
}
```

## Configure signers

```http
PUT /v1/accounts/:address/signers
```

Configures the multi-sign signer list. `quorum: 0` with an empty `signers` array deletes the list.

### Request body

| Field     | Type    | Description                                     |
| --------- | ------- | ----------------------------------------------- |
| `quorum`  | integer | Required total signer weight (0 to remove list) |
| `signers` | array   | 0–32 entries of `{ address, weight }`           |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## Rotate regular key

```http
POST /v1/accounts/:address/rotate-key
```

Installs or removes the regular key. Pass `null` (or omit the field) to clear it.

### Request body

| Field         | Type           | Description                                |
| ------------- | -------------- | ------------------------------------------ |
| `regular_key` | string \| null | New regular key address, or null to remove |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## Delete account

```http
DELETE /v1/accounts/:address
```

Submits `AccountDelete` with the remaining XRP balance swept to `destination`. Subject to XRPL's own 256-ledger cooldown requirement; the tx may return `tecTOO_SOON` if invoked too early, in which case retry after ~15 minutes.

### Request body

| Field             | Type    | Description                               |
| ----------------- | ------- | ----------------------------------------- |
| `destination`     | string  | XRPL address to receive remaining balance |
| `destination_tag` | integer | Optional destination tag                  |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```
