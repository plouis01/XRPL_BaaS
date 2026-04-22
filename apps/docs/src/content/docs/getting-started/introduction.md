---
title: Introduction
description: What RailForge is, who it's for, and the shape of the API surface.
---

RailForge is a REST API that lets developers build financial apps on XRPL without understanding how XRPL works. Think _Stripe for XRPL_ — you call `POST /v1/accounts`, `POST /v1/tokens`, `POST /v1/payments`, `POST /v1/credentials`, and RailForge handles the hard parts: HSM-backed key management, transaction signing and sequencing, reserve funding, webhook delivery on confirmation, and the translation from clean REST semantics to XRPL's raw transaction model.

## API surface

| Resource                              | XRPL primitives                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| [Accounts](/api/accounts/)            | AccountSet, AccountDelete, SignerListSet, SetRegularKey                            |
| [Tokens](/api/tokens/)                | MPTokenIssuanceCreate / Set, TrustSet, Payment, Clawback                           |
| [Payments](/api/payments/)            | Payment (XRP / MPT / issued-currency / cross-currency), EscrowCreate/Finish/Cancel |
| [Credentials](/api/credentials/)      | XLS-70 CredentialCreate / Accept / Delete                                          |
| [Permissioned Domains](/api/domains/) | XLS-80 PermissionedDomainSet / Delete                                              |
| [Permissions](/api/permissions/)      | XLS-75 delegation (pre-V1.1: SignerListSet with role-specific lists)               |
| [DEX](/api/dex/)                      | OfferCreate / Cancel, AMMDeposit / Withdraw, orderbook + pool reads                |
| [Webhooks](/api/webhooks/)            | Signed HTTP callbacks for the 9 lifecycle events                                   |
| [Dashboard](/api/dashboard/)          | Session login + API-key CRUD for the first-party React dashboard                   |

## Key concepts

### Semi-custodial by default

RailForge generates accounts and stores master keys in a hardware security module (AWS CloudHSM in production, SoftHSM in dev). Your application uses regular keys or delegated permissions for day-to-day operations. Advanced clients can opt into fully non-custodial mode — RailForge orchestrates the transaction pipeline but holds no keys.

### MPTs are the default token model

Multi-Purpose Tokens are the default for all new token issuances — simpler data model, lower reserve cost, designed for the stablecoin / RWA use case that BaaS clients care about most. Trust lines remain available as an opt-in for clients who need deep DEX liquidity or cross-currency path finding.

### Idempotency is mandatory

Every state-changing endpoint (POST / PUT / PATCH / DELETE) requires an `Idempotency-Key` header. The SDK generates one per call automatically. The cache is scoped per-client and bound by Redis lock so two concurrent requests with the same key never both run the handler. See [Authentication › Idempotency](/getting-started/authentication/#idempotency).

### Async transaction processing

Most write operations return `202 Accepted` with a `tx_id`. The worker pipeline (sequencer → signer → submitter → confirmer) handles signing, sequence coordination, submission to rippled, and validation polling. Track outcomes via `GET /v1/payments/:id` or — preferably — by subscribing a [webhook endpoint](/api/webhooks/) to `transaction.validated` / `transaction.failed`.

### On-chain compliance primitives, marketplace issuers

RailForge wraps XLS-70 credentials, XLS-80 permissioned domains, and (when V1.1 lands) XLS-75 granular delegation. It does **not** act as a KYC credential issuer — that's a deliberate regulatory-liability decision. The platform runs a curated marketplace of third-party issuers (Sumsub, Veriff, Synaps, etc.); you pick a qualified issuer and RailForge provides the on-chain infrastructure.

### XRPL native only

No EVM sidechain support. Clients needing smart contracts should use our sister product **Multisubs** on Base. RailForge's differentiation is wrapping XRPL-native primitives that nobody else abstracts at the API level.

## Security posture

- **HSM-backed signing.** Master keys never leave the HSM boundary. Only the DER-encoded signature comes out.
- **Fail-closed auth.** API keys are HMAC-SHA256-hashed with a server-side pepper; unknown / revoked / environment-mismatched keys return a generic 401/403 (no enumeration oracle).
- **Two-layer rate limiting.** Per-IP pre-auth bucket (300 req/min) plus per-key sliding window; DEX read routes have a tighter dedicated cap.
- **Signed + versioned webhooks.** HMAC-SHA256 over `timestamp + "." + body`, scheme version header for forward-compatible evolution, 5-minute replay window, SSRF guard on delivery.
- **Mainnet friction by design.** Every mainnet-touching command requires both `XRPL_NETWORK=mainnet` and `RAILFORGE_ALLOW_MAINNET=1` — two independent locks.
- **Idempotency + revocation re-check on every state-changing request.** Replays are safe; a key revoked mid-flight cannot submit a tx.

## What's next

- New to the API? → [Quickstart](/getting-started/quickstart/) (5 minutes, 4 commands).
- Integrating from scratch? → [Authentication](/getting-started/authentication/) + [Webhooks](/api/webhooks/).
- Looking for a resource? → the API Reference pages on the left sidebar.
- Using TypeScript? → [TypeScript SDK](/sdk/typescript/).
