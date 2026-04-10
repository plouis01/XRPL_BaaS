---
title: Introduction
description: What is RailForge and why use it.
---

RailForge is a REST API that lets developers build financial apps on XRPL without understanding how XRPL works.

## What it does

- **Account management** — Create, fund, and configure XRPL accounts with multi-sign support
- **Token issuance** — Issue fungible tokens via MPTs (default) or trust lines, with freeze and clawback
- **Payments** — Send XRP, MPT, and issued-currency payments, plus escrows
- **Webhooks** — Get notified when transactions are confirmed or fail
- **Key management** — HSM-backed master keys, regular keys for day-to-day operations

## Key concepts

### Semi-custodial by default

RailForge generates accounts and stores master keys in HSM. Your application receives a regular key for day-to-day operations. Advanced users can opt for fully non-custodial mode.

### MPTs are the default token model

Multi-Purpose Tokens are the default for all new token issuances — simpler data model, lower reserve cost. Trust lines remain available as an opt-in.

### Idempotency

All state-changing endpoints require an `Idempotency-Key` header. The SDK generates these automatically.

### Async transaction processing

Most write operations return `202 Accepted` with a `tx_id`. Use the payments status endpoint or webhooks to track confirmation.
