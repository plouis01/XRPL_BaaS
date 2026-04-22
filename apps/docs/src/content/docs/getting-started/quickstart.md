---
title: Quickstart
description: Create an account, issue a token, send a payment, and wire up a webhook in 5 minutes.
---

## 1. Install the SDK

```bash
bun add @railforge/sdk
# or: npm install @railforge/sdk
# or: pnpm add @railforge/sdk
```

## 2. Initialize the client

```typescript
import { RailForge } from "@railforge/sdk";

const rf = new RailForge({
  apiKey: "rf_test_your_key_here",
  network: "testnet",
});
```

## 3. Create an account

```typescript
const account = await rf.accounts.create({
  label: "my-first-account",
});

console.log(account.address); // "rXXX..."
console.log(account.is_funded); // false — treasury funding is async
```

Poll `rf.accounts.get(account.address)` until `is_funded` flips to `true` (~4 s on testnet under normal load).

## 4. Issue a token

MPT is the default token model — simpler data shape, lower reserve cost. Trust lines are opt-in via `type: "trustline"`.

```typescript
const token = await rf.tokens.create({
  issuer: account.address,
  currency_code: "USD",
  clawback: true,
});

console.log(token.id);
// token.mpt_issuance_id is null until the create tx validates on-ledger.
```

## 5. Send a payment

```typescript
const tx = await rf.payments.send({
  source: account.address,
  destination: "rRecipientAddress...",
  amount_drops: "1000000", // 1 XRP
});

console.log(tx.tx_id);

// Track with either a poll …
const status = await rf.payments.get(tx.tx_id);
// … or a webhook (next step).
```

## 6. Listen for events

```typescript
const endpoint = await rf.webhooks.create({
  url: "https://your-app.com/webhooks/railforge",
  events: ["transaction.validated", "transaction.failed"],
});

console.log(endpoint.secret);
// whsec_2d8f...7b3c — save this NOW. It's returned only here.
```

Your receiver verifies every POST with the [v1 signature scheme](/api/webhooks/#verifying-webhook-signatures) — `HMAC-SHA256(secret, timestamp + "." + body)`. Reject any delivery older than 5 minutes.

## Where to go next

- [Authentication](/getting-started/authentication/) — cookie sessions, rate limiting, idempotency, spend policies.
- [Webhooks](/api/webhooks/) — full event list, retry semantics, SSRF guard notes.
- [Credentials](/api/credentials/) + [Permissioned Domains](/api/domains/) — compliance primitives.
- [TypeScript SDK](/sdk/typescript/) — all 8 resource clients with code snippets.
