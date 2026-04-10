---
title: Quickstart
description: Get up and running with RailForge in 5 minutes.
---

## Install the SDK

```bash
npm install @railforge/sdk
```

## Initialize the client

```typescript
import { RailForge } from "@railforge/sdk";

const rf = new RailForge({
  apiKey: "rf_test_your_key_here",
  network: "testnet",
});
```

## Create an account

```typescript
const account = await rf.accounts.create({
  label: "my-first-account",
});

console.log(account.address); // rXXX...
```

## Issue a token

```typescript
const token = await rf.tokens.create({
  issuer: account.address,
  currency_code: "USD",
});

console.log(token.id);
```

## Send a payment

```typescript
const tx = await rf.payments.send({
  source: account.address,
  destination: "rRecipientAddress...",
  amount_drops: "1000000", // 1 XRP
});

console.log(tx.tx_id); // Track with rf.payments.get(tx.tx_id)
```

## Listen for events

```typescript
const endpoint = await rf.webhooks.create({
  url: "https://your-app.com/webhooks/railforge",
  events: ["transaction.validated", "transaction.failed"],
});

// Save the secret — it's shown only once
console.log(endpoint.secret);
```
