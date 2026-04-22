---
title: Permissioned Domains
description: XLS-80 credential-gated domains for KYC-restricted environments.
---

Permissioned Domains (XLS-80) let a domain owner declare 1–10 acceptable issuer / credential-type pairs. An account qualifies for membership if it holds any credential matching one of those pairs. Use cases include KYC-restricted order books (via XLS-81 Permissioned DEX), compliance-gated lending pools, and institutional-only liquidity.

## Create domain

```http
POST /v1/domains
```

Submits `PermissionedDomainSet`. The owner must be a managed account.

### Request body

| Field                  | Type                                   | Description                                                          |
| ---------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| `owner_address`        | string                                 | Managed account that owns the domain.                                |
| `accepted_credentials` | array of `{ issuer, credential_type }` | 1–10 entries. `issuer` is an XRPL address; `credential_type` is hex. |

### Response `201 Created`

```json
{
  "id": "dom_3e9c...",
  "owner_address": "rOwner...",
  "domain_id": null,
  "accepted_credentials": [
    { "issuer": "rIssuer1...", "credential_type": "4B5943" }
  ],
  "status": "queued",
  "tx_id": "tx_a1c3...",
  "created_at": "2026-04-22T12:00:00.000Z"
}
```

`domain_id` is the on-ledger PermissionedDomain entry ID; it's backfilled by the indexer after the tx validates (~4 s under normal conditions).

## Get domain

```http
GET /v1/domains/:id
```

Returns the same shape as create.

## Update domain

```http
PUT /v1/domains/:id
```

Replaces the `accepted_credentials` list (not additive — send the full desired state). The DB row's `pending_accepted_credentials` holds the staged list while the tx is in flight; review finding #22 / Sprint 7 closed the direct-live-write TOCTOU.

### Request body

| Field                  | Type                                   | Description                               |
| ---------------------- | -------------------------------------- | ----------------------------------------- |
| `accepted_credentials` | array of `{ issuer, credential_type }` | 1–10 entries replacing the existing list. |

### Response `200 OK`

Same shape as create.

## Delete domain

```http
DELETE /v1/domains/:id
```

Submits `PermissionedDomainDelete`. While the tx is in flight the DB row carries `pending_deletion: true`; the confirmer sets `deleted_at` on `tesSUCCESS` or clears the flag on expiry.

### Response `202 Accepted`

```json
{ "id": "dom_3e9c...", "tx_id": "tx_a1c3...", "status": "queued" }
```

## List domain members

```http
GET /v1/domains/:id/members?limit=100&offset=0
```

Returns accounts that hold at least one credential matching the domain's accepted list. Paginated via SQL `LIMIT`/`OFFSET` (review finding "listMembers SQL pagination push" — Sprint 7).

### Response `200 OK`

```json
{
  "data": [
    { "account": "rMember1...", "via_credential_id": "cred_9a2f..." },
    { "account": "rMember2...", "via_credential_id": "cred_7e4d..." }
  ],
  "pagination": { "limit": 100, "offset": 0, "total": 2 }
}
```

## Check membership

```http
POST /v1/domains/:id/check
```

Synchronous "does this account qualify?" check — useful as a gate in application logic before inviting a user into a permissioned flow.

### Request body

| Field             | Type   | Description           |
| ----------------- | ------ | --------------------- |
| `subject_address` | string | The account to check. |

### Response `200 OK`

```json
{
  "qualifies": true,
  "via_credential_id": "cred_9a2f..."
}
```

If the account holds multiple qualifying credentials, the first-accepted one (oldest by `created_at`) is returned in `via_credential_id`.

## Domain webhooks

| Event            | When it fires                                                        |
| ---------------- | -------------------------------------------------------------------- |
| `domain.created` | A `PermissionedDomainSet` creating a new entry validates on-ledger.  |
| `domain.updated` | A `PermissionedDomainSet` on an existing domain validates on-ledger. |
| `domain.deleted` | A `PermissionedDomainDelete` validates on-ledger.                    |

See [Webhooks](/api/webhooks/) for delivery semantics.
