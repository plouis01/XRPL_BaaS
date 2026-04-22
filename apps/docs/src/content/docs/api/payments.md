---
title: Payments
description: Send XRP, MPT, and issued-currency payments, plus escrows and sequential batches.
---

## Send payment

```http
POST /v1/payments
```

Sends an XRP, MPT, or issued-currency payment. The request body is polymorphic — supply **exactly one** of the three amount groups.

### XRP payment

```json
{
  "source": "rSender...",
  "destination": "rRecipient...",
  "amount_drops": "1000000"
}
```

### MPT payment

```json
{
  "source": "rSender...",
  "destination": "rRecipient...",
  "mpt_issuance_id": "00000001A407AF5856...",
  "value": "100.00"
}
```

### Issued-currency payment

```json
{
  "source": "rSender...",
  "destination": "rRecipient...",
  "currency": "USD",
  "issuer": "rIssuer...",
  "value": "100.00"
}
```

Cross-currency payments (source holds one currency, destination requests another) use this same shape — rippled auto-finds paths when `Paths` is omitted.

### Optional fields

| Field             | Type    | Description      |
| ----------------- | ------- | ---------------- |
| `destination_tag` | integer | Destination tag  |
| `memo`            | string  | Transaction memo |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

### Spend policy

XRP payments run through `enforceSpendPolicy` against the client's `spend_policies` row (per-tx + daily 24-hour rolling limit). MPT / issued-currency payments run through `enforceTokenOpCount` (per-day count ceiling, default 5000). Over-limit requests fail 400 before the tx is enqueued.

## Get payment status

```http
GET /v1/payments/:id
```

### Response `200 OK`

```json
{
  "id": "tx_a1c3...",
  "tx_type": "Payment",
  "source_address": "rSender...",
  "status": "validated",
  "result_code": "tesSUCCESS",
  "tx_hash": "ABC123...",
  "ledger_index": 91234567,
  "fee_drops": "12",
  "created_at": "2026-04-22T12:00:00.000Z",
  "submitted_at": "2026-04-22T12:00:01.000Z",
  "confirmed_at": "2026-04-22T12:00:05.000Z"
}
```

`status` progresses through `queued → submitting → submitted → validated` (or `failed` on any terminal XRPL result or LastLedgerSequence expiry).

## Batch payments

```http
POST /v1/payments/batch
```

Sequential fallback for XLS-56 — true on-chain atomicity requires the Batch amendment (V1.1 pending). Two modes are supported; the two atomic modes (`ALL_OR_NOTHING`, `ONLY_ONE`) are rejected at the schema layer with 501 until V1.1 activates.

### Request body

| Field      | Type                             | Default         | Description                                        |
| ---------- | -------------------------------- | --------------- | -------------------------------------------------- |
| `mode`     | `UNTIL_FAILURE` \| `INDEPENDENT` | `UNTIL_FAILURE` | Stop on first pre-submission error, or keep going. |
| `payments` | array of `sendPayment` bodies    | —               | 1–100 entries, same polymorphic shape as above.    |

### Response

- `202 Accepted` when every item was accepted for submission.
- `207 Multi-Status` when at least one item failed pre-submission validation.

```json
{
  "mode": "UNTIL_FAILURE",
  "results": [
    {
      "index": 0,
      "tx_id": "tx_a...",
      "status": "queued",
      "error_code": null,
      "error_message": null
    },
    {
      "index": 1,
      "tx_id": null,
      "status": "error",
      "error_code": "source_not_funded",
      "error_message": "Source account is not yet funded"
    }
  ]
}
```

Already-enqueued items (indices 0..n-1 where n is the first failure) continue submitting — the caller is expected to poll each `tx_id` or listen for `transaction.validated` / `transaction.failed` webhooks, and issue compensating txs if needed.

## Create escrow

```http
POST /v1/payments/escrows
```

Creates a time- or condition-based escrow. At least one of `finish_after` or `cancel_after` is required.

### Request body

| Field             | Type    | Description                                         |
| ----------------- | ------- | --------------------------------------------------- |
| `source`          | string  | Source XRPL address                                 |
| `destination`     | string  | Destination XRPL address                            |
| `amount_drops`    | string  | XRP amount in drops                                 |
| `finish_after`    | integer | XRPL epoch time after which escrow can be finished  |
| `cancel_after`    | integer | XRPL epoch time after which escrow can be cancelled |
| `condition`       | string  | PREIMAGE-SHA-256 crypto-condition (hex)             |
| `destination_tag` | integer | Optional                                            |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## Finish escrow

```http
POST /v1/payments/escrows/:id/finish
```

### Request body

| Field            | Type    | Description                                                                   |
| ---------------- | ------- | ----------------------------------------------------------------------------- |
| `source`         | string  | Account submitting the EscrowFinish (typically the destination).              |
| `owner`          | string  | Account that created the escrow (required field on EscrowFinish).             |
| `offer_sequence` | integer | The `Sequence` of the EscrowCreate tx.                                        |
| `condition`      | string  | Crypto-condition hex (required if the escrow was created with `condition`).   |
| `fulfillment`    | string  | Crypto-fulfillment hex (required if the escrow was created with `condition`). |

## Cancel escrow

```http
POST /v1/payments/escrows/:id/cancel
```

### Request body

| Field            | Type    | Description                          |
| ---------------- | ------- | ------------------------------------ |
| `source`         | string  | Account submitting the EscrowCancel. |
| `owner`          | string  | Account that created the escrow.     |
| `offer_sequence` | integer | `Sequence` of the EscrowCreate tx.   |
