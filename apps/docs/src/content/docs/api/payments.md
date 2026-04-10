---
title: Payments
description: Send payments and manage escrows on XRPL.
---

## Send payment

```http
POST /v1/payments
```

Sends an XRP, MPT, or issued-currency payment. The request body uses a polymorphic format — include exactly one of the amount fields.

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

### Issued currency payment

```json
{
  "source": "rSender...",
  "destination": "rRecipient...",
  "currency": "USD",
  "issuer": "rIssuer...",
  "value": "100.00"
}
```

### Optional fields

| Field             | Type    | Description      |
| ----------------- | ------- | ---------------- |
| `destination_tag` | integer | Destination tag  |
| `memo`            | string  | Transaction memo |

### Response `202 Accepted`

```json
{ "tx_id": "uuid", "status": "queued" }
```

## Get payment status

```http
GET /v1/payments/:id
```

### Response `200 OK`

```json
{
  "id": "uuid",
  "tx_type": "Payment",
  "source_address": "rXXX...",
  "status": "validated",
  "result_code": "tesSUCCESS",
  "tx_hash": "ABC123...",
  "ledger_index": 12345678,
  "fee_drops": "12",
  "created_at": "2025-01-01T00:00:00.000Z",
  "submitted_at": "2025-01-01T00:00:01.000Z",
  "confirmed_at": "2025-01-01T00:00:05.000Z"
}
```

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

## Finish escrow

```http
POST /v1/payments/escrows/:id/finish
```

## Cancel escrow

```http
POST /v1/payments/escrows/:id/cancel
```
