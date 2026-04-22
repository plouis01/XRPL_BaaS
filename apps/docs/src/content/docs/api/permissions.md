---
title: Permissions (Delegation)
description: Grant, revoke, and audit account-level permissions via XLS-75 — multi-sign fallback today, granular delegation when V1.1 lands.
---

XLS-75 Permission Delegation lets one XRPL account (the _delegator_) authorize another account (the _delegate_) to submit a bounded set of transaction types on its behalf. The full granular form (DelegateSet ledger entries) waits on V1.1 to activate. Pre-V1.1, RailForge implements the same API surface using multi-sign with role-specific signer lists — granting adds the delegate to the delegator's signer list; revoking removes them. The wire contract is identical so caller code won't change when V1.1 lands.

## Grant permissions

```http
POST /v1/permissions
```

Adds `delegate_address` to `delegator_address`'s signer list with the given weight. Submits `SignerListSet`. Self-delegation (`delegator === delegate`) is rejected with 400.

### Request body

| Field               | Type    | Default | Description                                                                       |
| ------------------- | ------- | ------- | --------------------------------------------------------------------------------- |
| `delegator_address` | string  | —       | Managed account granting the permissions.                                         |
| `delegate_address`  | string  | —       | Account receiving the permissions (does not need to be managed).                  |
| `permissions`       | array   | —       | 1–10 permission strings (see list below).                                         |
| `weight`            | integer | `1`     | Signer weight for the delegate (1–65535).                                         |
| `quorum`            | integer | `1`     | Required total signer weight on the resulting list. Must be ≤ `sum(all weights)`. |

### Permission values

`Payment`, `TrustSet`, `OfferCreate`, `OfferCancel`, `AccountSet`, `EscrowCreate`, `EscrowFinish`, `EscrowCancel`, `CredentialCreate`, `CredentialAccept`, `CredentialDelete`.

> Pre-V1.1 this list is **recorded** in the `delegations` table for auditing, but the on-chain enforcement is signer-weight-based — the delegate can sign **any** tx type allowed by the signer list. Once V1.1 activates, the same request body emits `DelegateSet` instead and the permission list becomes on-chain-enforced.

### Response `201 Created`

```json
{
  "id": "del_8c1b...",
  "delegator_address": "rDelegator...",
  "delegate_address": "rDelegate...",
  "permissions": ["Payment", "TrustSet"],
  "status": "active",
  "created_at": "2026-04-22T12:00:00.000Z",
  "revoked_at": null,
  "tx_id": "tx_a1c3..."
}
```

### Quorum examples

- **Single delegate, any-one signs:** `weight: 1`, `quorum: 1`. Default.
- **Two delegates, 2-of-2 required:** grant both, each with `weight: 1`; on the second call set `quorum: 2`.
- **Three delegates, 2-of-3 required:** each with `weight: 1`, `quorum: 2`.

A tenant expecting 2-of-2 coordination who accepts the default `quorum: 1` gets either-one-solo-signs — the service validates and surfaces this (review finding MED-05 closed in Sprint 9).

## List delegations

```http
GET /v1/permissions/:delegator
```

Returns all _active_ delegations for the given delegator. Scoped to the authenticated client — a delegator address owned by another tenant returns an empty list.

### Response `200 OK`

```json
{
  "data": [
    {
      "id": "del_8c1b...",
      "delegator_address": "rDelegator...",
      "delegate_address": "rDelegate...",
      "permissions": ["Payment", "TrustSet"],
      "status": "active",
      "created_at": "2026-04-22T12:00:00.000Z",
      "revoked_at": null
    }
  ]
}
```

## Revoke delegation

```http
DELETE /v1/permissions/:delegator/:delegate
```

Rebuilds the delegator's signer list with `delegate_address` removed. The DB row moves to `pending_revocation` while the tx is in flight; the confirmer promotes to `revoked` on `tesSUCCESS` or reverts on expiry (TOCTOU staging — review finding C-1 closed).

### Request body

| Field               | Type   | Description                                  |
| ------------------- | ------ | -------------------------------------------- |
| `delegator_address` | string | Must match the path param (belt-and-braces). |

### Response `202 Accepted`

```json
{
  "id": "del_8c1b...",
  "tx_id": "tx_a1c3...",
  "status": "queued"
}
```

## Audit log

```http
GET /v1/permissions/audit/:delegator
```

Returns the history of permission grants and revocations for a delegator, including who initiated each change and the resulting on-chain tx. Useful for compliance reviews and reconstructing intent when an on-chain signer list disagrees with application state.

### Response `200 OK`

```json
{
  "data": [
    {
      "id": "aud_1a2f...",
      "op": "grant",
      "delegator_address": "rDelegator...",
      "delegate_address": "rDelegate...",
      "permissions": ["Payment", "TrustSet"],
      "weight": 1,
      "quorum": 1,
      "tx_id": "tx_a1c3...",
      "tx_result": "tesSUCCESS",
      "actor_api_key_prefix": "rf_test_",
      "created_at": "2026-04-22T12:00:00.000Z"
    }
  ]
}
```

## Protocol limits

- Max 10 permissions per delegation.
- A delegator can have multiple delegates; the signer list has a hard 32-entry limit.
- Critical operations (key rotation, further permission grants) cannot themselves be delegated — XRPL enforces this at the protocol level.
- Delegates pay their own transaction fees.
