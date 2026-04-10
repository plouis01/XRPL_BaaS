---
title: TypeScript SDK
description: Install and use the @railforge/sdk package.
---

## Installation

```bash
npm install @railforge/sdk
```

## Usage

```typescript
import { RailForge } from "@railforge/sdk";

const rf = new RailForge({
  apiKey: "rf_test_your_key_here",
  network: "testnet", // or 'mainnet'
});
```

### Custom base URL

For local development or self-hosted deployments:

```typescript
const rf = new RailForge({
  apiKey: "rf_test_abc",
  baseUrl: "http://localhost:3000",
});
```

## Resource clients

### Accounts

```typescript
// Create
const account = await rf.accounts.create({ label: "treasury" });

// Get
const info = await rf.accounts.get("rAddress...");

// Configure multi-sign
await rf.accounts.configureSigners("rAddress...", {
  quorum: 2,
  signers: [
    { address: "rSigner1...", weight: 1 },
    { address: "rSigner2...", weight: 1 },
    { address: "rSigner3...", weight: 1 },
  ],
});

// Rotate regular key
await rf.accounts.rotateKey("rAddress...", { regular_key: "rNewKey..." });

// Delete
await rf.accounts.delete("rAddress...", { destination: "rDest..." });
```

### Tokens

```typescript
// Issue MPT token
const token = await rf.tokens.create({
  issuer: "rIssuer...",
  currency_code: "USD",
  clawback: true,
});

// Transfer
await rf.tokens.transfer(token.id, {
  destination: "rHolder...",
  amount: "1000.00",
});

// Freeze
await rf.tokens.freeze(token.id, { unfreeze: false });

// Clawback
await rf.tokens.clawback(token.id, {
  holder: "rHolder...",
  amount: "500.00",
});
```

### Payments

```typescript
// XRP payment
await rf.payments.send({
  source: "rSender...",
  destination: "rRecipient...",
  amount_drops: "1000000",
});

// Check status
const payment = await rf.payments.get("tx-id-here");
console.log(payment.status); // 'queued' | 'submitted' | 'validated' | 'failed'

// Escrow
await rf.payments.createEscrow({
  source: "rSender...",
  destination: "rRecipient...",
  amount_drops: "5000000",
  finish_after: 784111600,
});
```

### Webhooks

```typescript
// Create endpoint
const endpoint = await rf.webhooks.create({
  url: "https://your-app.com/hooks",
  events: ["transaction.validated"],
});
console.log(endpoint.secret); // Save this!

// List endpoints
const { data } = await rf.webhooks.list();

// Delete
await rf.webhooks.delete(endpoint.id);
```

## Error handling

All API errors throw a `RailForgeError` with the HTTP status and error body:

```typescript
import { RailForgeError } from "@railforge/sdk";

try {
  await rf.accounts.get("rInvalid");
} catch (err) {
  if (err instanceof RailForgeError) {
    console.log(err.status); // 404
    console.log(err.body); // { error: 'Account not found' }
  }
}
```
