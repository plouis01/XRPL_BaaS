---
title: DEX
description: Place and cancel offers, deposit/withdraw from AMM pools, read orderbooks and pool info.
---

The DEX endpoints wrap XRPL's native central-limit order book plus the AMM amendment. All read paths (`/orderbook/*`, `/amm/:asset1/:asset2`) hit rippled live — no indexer lag — and are subject to a tighter per-key rate limit (30 req/min) to prevent free-tier bandwidth scraping.

## Asset shape

Every `amount` / `asset` field accepts one of three shapes:

| XRP                      | MPT                                                       | Issued currency                                                 |
| ------------------------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| `{ "drops": "1000000" }` | `{ "mpt_issuance_id": "00000001A4...", "value": "10.5" }` | `{ "currency": "USD", "issuer": "rIss...", "value": "100.00" }` |

For `asset` / `asset2` fields (currency-only, no value — used by AMM pool identifiers), pass the same shape but omit `value`. For XRP use `{ "drops": "0" }` or `{ "drops": true }` — the presence of `drops` signals "this is XRP".

## Create offer

```http
POST /v1/dex/offers
```

Submits `OfferCreate`. The offer appears on the orderbook at rate `taker_pays / taker_gets` until it's crossed, cancelled, or its `expiration` passes.

### Request body

| Field            | Type    | Description                                                                                                |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `account`        | string  | Managed account placing the offer.                                                                         |
| `taker_gets`     | amount  | What the maker is selling (what the taker gets).                                                           |
| `taker_pays`     | amount  | What the maker wants in exchange.                                                                          |
| `expiration`     | integer | Optional XRPL epoch time after which the offer auto-expires.                                               |
| `offer_sequence` | integer | Optional — cancels / replaces an existing offer by its Sequence.                                           |
| `flags`          | integer | Optional bitmask: `tfPassive=65536`, `tfImmediateOrCancel=131072`, `tfFillOrKill=262144`, `tfSell=524288`. |
| `domain_id`      | string  | Optional — restrict the offer to a permissioned-DEX domain (XLS-81).                                       |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

### Spend policy

Offers selling XRP run through the XRP spend policy (`enforceSpendPolicy`). Non-XRP offers run through the token-op count ceiling (`enforceTokenOpCount`). Over-limit requests fail 400.

## Cancel offer

```http
DELETE /v1/dex/offers/:id
```

The `:id` path param must match the `offer_sequence` in the body — belt-and-braces so a mistyped URL doesn't silently cancel the wrong offer.

### Request body

| Field            | Type    | Description                             |
| ---------------- | ------- | --------------------------------------- |
| `account`        | string  | Managed account that owns the offer.    |
| `offer_sequence` | integer | Sequence number of the offer to cancel. |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## Read orderbook

```http
GET /v1/dex/orderbook/:base/:counter?limit=50&source=rippled
```

Returns the orderbook at the top of the `base → counter` pair. The `base` and `counter` path params use URL-encoded asset identifiers:

| Asset           | URL form            |
| --------------- | ------------------- |
| XRP             | `XRP`               |
| Issued currency | `USD:rIssuer...`    |
| MPT             | `mpt:00000001A4...` |

### Query params

| Param    | Default   | Description                                                                                       |
| -------- | --------- | ------------------------------------------------------------------------------------------------- |
| `limit`  | `50`      | 1–400 offers to return.                                                                           |
| `source` | `rippled` | `rippled` (live, authoritative) or `indexer` (cached, as fresh as the indexer's high-water mark). |

### Response `200 OK`

```json
{
  "offers": [
    {
      "Account": "rMaker...",
      "Sequence": 123,
      "TakerGets": "1000000",
      "TakerPays": { "currency": "USD", "issuer": "rIss...", "value": "10" },
      "Flags": 0,
      "quality": "0.00001"
    }
  ],
  "ledger_index": 91234567,
  "source": "rippled"
}
```

## AMM deposit

```http
POST /v1/dex/amm/deposit
```

Deposits liquidity into an AMM pool identified by the unordered asset pair `(asset, asset2)`. Supply at least one of `amount`, `amount2`, `e_price`, or `lp_token_out` depending on the mode (single-asset, two-asset, effective-price, or fixed-LP-out).

### Request body

| Field          | Type                        | Description                                        |
| -------------- | --------------------------- | -------------------------------------------------- |
| `account`      | string                      | Managed account providing liquidity.               |
| `asset`        | amount                      | First asset in the pool (currency only, no value). |
| `asset2`       | amount                      | Second asset in the pool.                          |
| `amount`       | amount                      | Amount of `asset` to deposit (single-asset mode).  |
| `amount2`      | amount                      | Amount of `asset2` to deposit.                     |
| `e_price`      | amount                      | Effective price mode.                              |
| `lp_token_out` | `{currency, issuer, value}` | Fixed LP tokens out.                               |
| `flags`        | integer                     | XRPL AMM flags bitmask.                            |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## AMM withdraw

```http
POST /v1/dex/amm/withdraw
```

Mirror of deposit. Supply `lp_token_in` plus one or more of `amount` / `amount2` / `e_price` depending on the mode.

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## Read AMM pool info

```http
GET /v1/dex/amm/:asset1/:asset2
```

Live rippled `amm_info` query. `:asset1` / `:asset2` use the same URL encoding as the orderbook route.

### Response `200 OK`

```json
{
  "amm": {
    "account": "rAMMAccount...",
    "amount": "500000000",
    "amount2": { "currency": "USD", "issuer": "rIss...", "value": "5000" },
    "lp_token": {
      "currency": "03A4F9...",
      "issuer": "rAMMAccount...",
      "value": "50000"
    },
    "trading_fee": 500,
    "vote_slots": []
  },
  "ledger_index": 91234567
}
```

## Rate limiting on read routes

`GET /v1/dex/orderbook/:base/:counter` and `GET /v1/dex/amm/:asset1/:asset2` are capped at **30 req/min per API key** via a dedicated middleware (`dexReadRateLimit`, review finding MED-09) in addition to the global 300 req/min cap. Excessive calls return `429 Too Many Requests` with `X-DexRead-RateLimit-*` headers. Use the indexer source (`?source=indexer`) for high-frequency polling that doesn't need sub-second freshness.
