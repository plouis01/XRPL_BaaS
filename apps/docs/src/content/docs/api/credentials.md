---
title: Credentials
description: On-chain attestations via XLS-70 — issue, accept, revoke, verify.
---

RailForge wraps the XLS-70 Credentials amendment so fintechs can build KYC / KYB / accredited-investor gates without running their own attestation infrastructure. Each credential is an on-chain object owned by an issuer, bound to a subject, carrying a free-form hex-encoded `credential_type` (up to 64 bytes).

> **RailForge never acts as a credential issuer.** This is a deliberate regulatory-liability decision — the platform runs a marketplace of third-party issuers (e.g. Sumsub, Veriff, Synaps) and wraps the on-chain primitives. All endpoints below assume the issuer is either your own managed account or one of the registered marketplace issuers.

## Issue credential

```http
POST /v1/credentials
```

Submits `CredentialCreate`. The credential lands on-ledger in `pending` state; the subject must call [accept](#accept-credential) for it to become usable.

### Request body

| Field             | Type    | Description                                                      |
| ----------------- | ------- | ---------------------------------------------------------------- |
| `issuer_address`  | string  | Managed account performing the issuance.                         |
| `subject_address` | string  | The account receiving the credential.                            |
| `credential_type` | string  | Hex-encoded, 1–128 hex chars (= 0.5–64 bytes).                   |
| `expiration`      | integer | XRPL epoch time after which the credential is invalid. Optional. |
| `uri`             | string  | Hex-encoded URI pointing at off-chain metadata. Optional.        |
| `metadata`        | object  | Arbitrary JSON (≤ 8 KB serialized). Optional.                    |

### Response `202 Accepted`

```json
{
  "id": "cred_9a2f...",
  "issuer_address": "rIssuer...",
  "subject_address": "rSubject...",
  "credential_type": "4B5943",
  "status": "pending",
  "expires_at": 788_745_600,
  "tx_id": "tx_a1c3...",
  "created_at": "2026-04-22T12:00:00.000Z"
}
```

## Accept credential

```http
POST /v1/credentials/:id/accept
```

The subject accepts an issued credential by submitting `CredentialAccept`. Only the subject can call this — cross-tenant lookups return 404.

While the tx is in flight the credential status is `accepting`; the txConfirmer flips it to `accepted` on `tesSUCCESS`, or reverts to `pending` on LastLedgerSequence expiry (so the subject can retry).

### Request body

| Field             | Type   | Description                                |
| ----------------- | ------ | ------------------------------------------ |
| `subject_address` | string | Must match the credential's subject field. |

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## Revoke credential

```http
DELETE /v1/credentials/:id
```

Submits `CredentialDelete`. Callable by either the issuer or the subject. The DB row moves to `revoking` while the tx is in flight; the confirmer promotes to `revoked` on success or reverts on expiry (TOCTOU-safe staging — previously closed as review finding C-3).

### Response `202 Accepted`

```json
{ "tx_id": "tx_a1c3...", "status": "queued" }
```

## Verify credential

```http
POST /v1/credentials/verify
```

Synchronous check: does this subject hold a non-expired, accepted credential of `credential_type` from `issuer_address`?

### Request body

| Field             | Type   | Description              |
| ----------------- | ------ | ------------------------ |
| `subject_address` | string | The holder to check.     |
| `issuer_address`  | string | The expected issuer.     |
| `credential_type` | string | Hex-encoded type string. |

### Response `200 OK`

```json
{
  "valid": true,
  "credential_id": "cred_9a2f...",
  "status": "accepted",
  "expires_at": 788_745_600
}
```

The verification checks the platform's DB mirror of on-chain state. The indexer writes `processed_transactions` + updates the credential row on every ledger close that touches a Credential entry, so the mirror is authoritative within one ledger close (~4 s) of any on-chain change.

## List credentials for an account

The full list of credentials held by an account lives on the accounts resource for convenience:

```http
GET /v1/accounts/:address/credentials?limit=50&offset=0
```

See [Accounts › List credentials for account](/api/accounts/#list-credentials-for-account).

## Credential webhooks

Subscribe an endpoint to any of:

| Event                 | When it fires                                                     |
| --------------------- | ----------------------------------------------------------------- |
| `credential.issued`   | A `CredentialCreate` validates on-ledger.                         |
| `credential.accepted` | A `CredentialAccept` validates on-ledger.                         |
| `credential.revoked`  | A `CredentialDelete` validates on-ledger.                         |
| `credential.expiring` | A credential is ≤ 7 days from its `expires_at` (daily sweep job). |

See [Webhooks](/api/webhooks/) for delivery semantics.
