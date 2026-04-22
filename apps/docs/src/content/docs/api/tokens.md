---
title: Tokens
description: Issue and manage fungible tokens on XRPL — MPT by default, trust lines opt-in.
---

RailForge abstracts token issuance behind a single `create` call. The default primitive is the XLS-33 **Multi-Purpose Token** (MPT) — simpler data model, lower reserve cost, designed for the stablecoin / RWA use case. Trust lines remain available via `type: "trustline"` when you need deep DEX liquidity or cross-currency path finding.

## Create token

```http
POST /v1/tokens
```

Submits `MPTokenIssuanceCreate` (MPT path) or `TrustSet` (trust-line path) depending on `type`. Returns `202 Accepted` with the tokens row ID; the on-chain `mpt_issuance_id` is backfilled by `txConfirmer` once the tx validates (~4 s on testnet).

### Request body

| Field             | Type                 | Default | Description                                                                                                    |
| ----------------- | -------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `issuer`          | string               | —       | Managed issuer XRPL address. Must belong to the authenticated client.                                          |
| `type`            | `mpt` \| `trustline` | `mpt`   | Token primitive.                                                                                               |
| `currency_code`   | string               | —       | 1–40 characters. For MPTs this is free-form metadata; for trust lines it's the ISO 3-char code or 40-char hex. |
| `transfer_fee`    | integer              | `0`     | Basis points (0–50000 = 0%–50%).                                                                               |
| `clawback`        | boolean              | `true`  | Enable clawback on the issuance.                                                                               |
| `freeze_enabled`  | boolean              | `true`  | Enable freeze on the issuance.                                                                                 |
| `max_supply`      | string               | —       | Maximum supply as decimal string. Omit for unbounded.                                                          |
| `metadata`        | object               | —       | Arbitrary JSON (≤ 8 KB serialized — bounded by review finding LOW-08).                                         |
| `trustline_limit` | string               | —       | **Required** when `type: "trustline"`. Ignored otherwise.                                                      |

### Response `202 Accepted`

```json
{
  "id": "tok_7e3d...",
  "issuer_address": "rIssuer...",
  "token_type": "mpt",
  "currency_code": "USD",
  "mpt_issuance_id": null,
  "transfer_fee": 0,
  "clawback": true,
  "freeze_enabled": true,
  "max_supply": null,
  "status": "queued",
  "tx_id": "tx_a1c3...",
  "created_at": "2026-04-22T12:00:00.000Z"
}
```

Poll `GET /v1/payments/:tx_id` (or subscribe a `transaction.validated` webhook) to observe the create transaction land. After validation `mpt_issuance_id` is populated.

## Transfer tokens

```http
POST /v1/tokens/:id/transfer
```

Submits `Payment` in the appropriate amount shape (MPT or issued currency) from the issuer to `destination`. Trust-line transfers assume the holder has already established their trust line.

Runs through `enforceTokenOpCount` — the per-client daily count ceiling on non-XRP state-changing ops (default 5000/day, configurable via `TOKEN_OPS_DAILY_LIMIT`).

### Request body

| Field             | Type    | Description                          |
| ----------------- | ------- | ------------------------------------ |
| `destination`     | string  | Recipient XRPL address.              |
| `amount`          | string  | Amount to transfer (decimal string). |
| `destination_tag` | integer | Optional destination tag.            |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## Freeze / unfreeze

```http
PUT /v1/tokens/:id/freeze
```

MPT only for now. Omit `holder` to lock the entire issuance; provide it to lock a single holder. Trust-line freeze is a different primitive (TrustSet with tfSetFreeze) and is deferred to a later sprint — trust-line tokens return 400 with `invalid_input` on this route.

### Request body

| Field      | Type    | Default | Description                          |
| ---------- | ------- | ------- | ------------------------------------ |
| `holder`   | string  | —       | Specific holder to lock (optional).  |
| `unfreeze` | boolean | `false` | Pass `true` to unlock (tfMPTUnlock). |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## Clawback

```http
PUT /v1/tokens/:id/clawback
```

Reclaims tokens from a holder. Requires `clawback: true` on the token at creation. Works for both MPT and trust-line tokens — the service picks the right builder based on `token_type`.

### Request body

| Field    | Type   | Description                          |
| -------- | ------ | ------------------------------------ |
| `holder` | string | XRPL address to reclaim from.        |
| `amount` | string | Amount to clawback (decimal string). |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## MPT vs trust lines

| Dimension             | MPT (default)                                                 | Trust line                                                  |
| --------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| On-ledger primitive   | XLS-33 `MPTokenIssuance` + `MPToken` per holder               | Classic issued currency + `TrustLine` per holder            |
| Reserve cost          | Lower — one issuance object, lightweight per-holder `MPToken` | Higher — each trust line is an owner reserve unit           |
| DEX liquidity         | Supported, but thinner than classic currencies today          | Deep — long-standing liquidity on XRPL's native DEX         |
| Cross-currency paths  | Not yet; direct payments only                                 | Full XRPL path finding                                      |
| Freeze / clawback     | Native (tfMPTLock, Clawback)                                  | Freeze via TrustSet flag (not yet wrapped); clawback native |
| Default client choice | ✅ pick this for stablecoins / RWAs                           | pick this if you need deep existing DEX liquidity           |

Unless you have a specific reason to opt in, use MPTs. Trust lines stay available for the cases that need them.
