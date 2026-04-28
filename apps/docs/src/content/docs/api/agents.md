---
title: Agents (Agent Launcher)
description: Provision delegate keypairs with allowlists and spend caps in one POST. Built on permissions + spend policies; XLS-75 V1.1 ready when it lands.
---

The agent launcher provisions a bounded delegate on a managed parent account in one call. Behind the scenes it composes the same primitives you can compose by hand — `POST /v1/permissions` (signer-list grant), spend-policy upsert, and an allowlist write — but with preset-driven defaults and a single transactional rollback path. The delegate seed is returned **exactly once** and never appears in subsequent reads.

When XLS-75 V1.1 activates, the same wire contract emits `DelegateSet` instead of a signer-list grant. Caller code does not change.

## Why agents

Without the launcher, hardening an automated payment bot is a multi-step ceremony:

1. Generate a keypair (off-platform, with the seed-handling that implies)
2. `POST /v1/permissions` to add it to the parent's signer list
3. Insert spend caps via `POST /v1/dashboard/spend-policy`
4. Maintain your own allowlist of permitted destinations / tokens
5. Gate every payment against that allowlist before submitting

The launcher does all five. The bot then receives an API key bound to the agent (`POST /v1/dashboard/keys` with `agent_id`), and `POST /v1/payments` calls from that key are gated automatically — destinations off the allowlist return 403 before any tx is enqueued.

## Provision an agent

```http
POST /v1/agents
```

Generates the delegate keypair, queues the `SignerListSet` that grants on-ledger authority, installs the spend policy, and writes the allowlist atomically. The `agent_seed` field in the response is the only copy the platform ever returns — persist it before the response is discarded.

### Request body

| Field            | Type    | Default             | Description                                                                                               |
| ---------------- | ------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| `preset`         | string  | —                   | One of `payment-agent`, `treasury-agent` (see [Presets](#presets)).                                       |
| `parent_address` | string  | —                   | Managed, funded account owned by the caller. Cannot itself be an agent (`metadata.agent_of` set rejects). |
| `label`          | string  | `null`              | Optional human-readable name (1–128 chars). Surfaces in the dashboard.                                    |
| `allowlist`      | array   | `[]`                | 0–100 entries; preset dictates which `entry_type` values are valid (see below).                           |
| `spend_policy`   | object  | (preset's defaults) | Override per-tx and daily XRP caps. Pass `null` for a field to disable that cap entirely.                 |
| `quorum`         | integer | `1`                 | Signer-list quorum to install on the parent. Raise this if co-signing with an existing delegate.          |

### Allowlist entries

```json
{ "entry_type": "destination" | "token" | "domain", "entry_value": "..." }
```

- `destination` — XRPL r-address (24–34 base58 chars after `r`).
- `token` — MPT issuance ID (48 hex) **or** `<currency>:<issuer>` for IOUs (currency is 3 chars or 40 hex; issuer is an r-address).
- `domain` — XLS-80 `DomainID` (64 hex). Only allowed by `treasury-agent`.

The `payment-agent` preset rejects `domain` entries at validation time. `treasury-agent` accepts all three.

### Response `201 Created`

```json
{
  "id": "agt_8c1b...",
  "preset": "payment-agent",
  "parent_address": "rParent...",
  "agent_address": "rAgent...",
  "label": "supplier-payouts",
  "status": "pending",
  "allowlist": [
    { "entry_type": "destination", "entry_value": "rSupplierA..." }
  ],
  "spend_policy": {
    "max_xrp_per_tx_drops": "10000000",
    "daily_xrp_limit_drops": "100000000"
  },
  "created_at": "2026-04-28T11:00:00.000Z",
  "agent_seed": "sEd7...",
  "grant_tx_id": "tx_a1c3..."
}
```

`status` is `'pending'` until the `grant_tx_id` validates on-ledger; the `txConfirmer` flips it to `'active'` on `tesSUCCESS`. Poll `GET /v1/agents/:id` (or subscribe to webhooks) for the transition.

> **Persist `agent_seed` immediately.** Subsequent `GET` responses do not include it, and there is no recovery path — a lost seed means re-provisioning. The seed is redacted at every log boundary.

### Error codes

| HTTP | `error` shape                                | Cause                                                                                            |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 400  | invalid preset / allowlist / parent-is-agent | Schema or service-layer rejection. `parent_is_agent` blocks an agent-mode account being chained. |
| 404  | `Parent account not found`                   | The address isn't a managed account owned by this client.                                        |
| 409  | parent not funded / db conflict              | Wait for the parent's funding tx to validate, or retry on db conflict.                           |
| 503  | `Failed to enqueue — please retry`           | Redis hiccup or worker outage. Idempotent retry is safe.                                         |

## List agents

```http
GET /v1/agents
```

Returns every agent owned by the authenticated client (across all parents). Order is unspecified; expect to filter client-side. Allowlists and spend policies are inlined.

### Response `200 OK`

```json
{
  "data": [
    {
      "id": "agt_8c1b...",
      "preset": "payment-agent",
      "parent_address": "rParent...",
      "agent_address": "rAgent...",
      "label": "supplier-payouts",
      "status": "active",
      "pending_revocation": false,
      "allowlist": [
        { "entry_type": "destination", "entry_value": "rSupplierA..." }
      ],
      "spend_policy": {
        "max_xrp_per_tx_drops": "10000000",
        "daily_xrp_limit_drops": "100000000"
      },
      "created_at": "2026-04-28T11:00:00.000Z"
    }
  ]
}
```

## Get an agent

```http
GET /v1/agents/:id
```

Single-agent read. Use this to poll `pending → active` after `provision`. Returns 404 (not 403) for agent IDs owned by another tenant — cross-tenant lookups are indistinguishable from non-existent IDs by design.

## Update allowlist

```http
PUT /v1/agents/:id/allowlist
```

Replaces the agent's allowlist atomically. Pure DB operation — no on-ledger work, since the underlying `SignerListSet` doesn't reference individual destinations or tokens. The agent's preset is immutable post-provision and continues to dictate which `entry_type` values are valid (e.g. `payment-agent` still rejects `domain`).

**Replace semantics.** The body's `allowlist` is the new full list. To "add an entry": fetch via `GET /v1/agents/:id`, append, then `PUT`. To "remove": fetch, filter, then `PUT`.

### Request body

| Field       | Type  | Description                                                                                    |
| ----------- | ----- | ---------------------------------------------------------------------------------------------- |
| `allowlist` | array | 0–100 entries. Same shape as the provision-time `allowlist` (see [above](#allowlist-entries)). |

### Status gate

Only agents in `status='active'` accept updates. Any of the following return **409**:

- `status='pending'` — grant tx hasn't validated yet. Wait for activation, then PUT.
- `pending_revocation=true` — a revoke is in flight. Don't race the revoke; either complete it or wait for it to clear.
- `status='revoked'`, `'failed'`, `'revoking'` — terminal or in-flight; cannot mutate.

### Response `200 OK`

The updated agent view (same shape as `GET /v1/agents/:id`):

```json
{
  "id": "agt_8c1b...",
  "preset": "payment-agent",
  "parent_address": "rParent...",
  "agent_address": "rAgent...",
  "label": "supplier-payouts",
  "status": "active",
  "pending_revocation": false,
  "allowlist": [
    { "entry_type": "destination", "entry_value": "rSupplierA..." },
    { "entry_type": "destination", "entry_value": "rSupplierB..." }
  ],
  "spend_policy": {
    "max_xrp_per_tx_drops": "10000000",
    "daily_xrp_limit_drops": "100000000"
  },
  "created_at": "2026-04-28T11:00:00.000Z"
}
```

### Error codes

| HTTP | `error` shape                             | Cause                                                                                |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| 400  | `invalid_allowlist`                       | An entry's shape is wrong for the agent's preset (e.g. `domain` on `payment-agent`). |
| 400  | `allowlist_required`                      | Preset (`payment-agent`) requires at least one entry; `[]` was submitted.            |
| 404  | `Agent not found`                         | No row matches client + agent (cross-tenant lookups also surface as 404).            |
| 409  | `agent_not_updatable` (status / revoking) | See the status gate above.                                                           |
| 409  | `Conflict — please retry`                 | Transient transaction failure. Pure DB op, so retry is safe.                         |

> Spend-policy caps are not modified by this endpoint. Use the dashboard / spend-policy endpoint to adjust those independently.

## Revoke an agent

```http
DELETE /v1/agents/:id
```

Stages a revocation: queues a `SignerListSet` that strips the delegate from the parent's signer list, sets `pending_revocation: true`, and returns `202`. The `txConfirmer` promotes `status` to `'revoked'` on `tesSUCCESS` (or clears the flag and reverts to `'active'` if the tx fails).

Only agents in `status='active'` can be revoked. Revoking a `pending` agent is rejected with 409 — wait for the grant tx to validate, then revoke.

### Response `202 Accepted`

```json
{
  "agent_id": "agt_8c1b...",
  "status": "revoking",
  "tx_id": "tx_b9f0..."
}
```

## Presets

Presets are code-defined templates that bundle a permission set, default spend caps, and the allowlist entry types the agent may use. They're not user-configurable — adding a preset ships through CI + review. Two are live in v1:

| Preset           | Permissions | Per-tx cap | Daily cap  | Allowlist types                  | Allowlist required   |
| ---------------- | ----------- | ---------- | ---------- | -------------------------------- | -------------------- |
| `payment-agent`  | `Payment`   | 10 XRP     | 100 XRP    | `destination`, `token`           | yes                  |
| `treasury-agent` | `Payment`   | 1,000 XRP  | 10,000 XRP | `destination`, `token`, `domain` | no (may start empty) |

Caller-supplied `spend_policy` fields override the preset defaults. Pass `null` to disable a cap entirely (use sparingly).

## Enforcement path

Once an agent's grant tx validates, the API key bound to that agent (`POST /v1/dashboard/keys` with `agent_id` set) is gated on every state-changing call:

- `POST /v1/payments` — `authorizeAgentPayment` runs after source resolution and before tx enqueue. Failure paths:
  - `agent_not_found`, `agent_not_active` → 400 (`invalid_input`)
  - `source_not_parent`, `destination_not_allowlisted`, `token_not_allowlisted` → 400 (`invalid_input`)
- `POST /v1/payments/escrows`, `POST /v1/payments/escrows/:id/finish`, `POST /v1/payments/escrows/:id/cancel`, `POST /v1/payments/batch` — agent keys are rejected at the route layer with **403** by `requireNotAgent`. Escrows and batch are not currently allowlist-gated; the route refuses outright.

XRP spend is also bounded by `enforceSpendPolicy` (per-tx + daily) and non-XRP state-changing operations by `enforceTokenOpCount` (default 5,000/day). Both apply to all clients but matter most for agents, where the caps are the primary safety budget.

## Webhooks

Agent lifecycle events are published over the same webhook engine as the rest of the API:

- `agent.activated` — the grant tx validated; the agent is on-ledger and gating is live.
- `agent.failed` — the grant tx terminally failed; the agent's `status` is `'failed'`.
- `agent.revoked` — the revoke tx validated; the agent is fully off-ledger.

Revocation tx failure does not fire a webhook — the agent stays `'active'` and gating is still in force, so callers polling `GET /v1/agents/:id` will see `pending_revocation` flip back to `false` and can retry the `DELETE`.

Subscribe per `POST /v1/webhooks/endpoints`; payload shape mirrors the `transaction.*` events with the agent ID and parent address attached.
