---
title: TypeScript SDK
description: Install and use the @railforge/sdk package — 9 resource clients, auto-idempotency, typed errors.
---

## Installation

```bash
npm install @railforge/sdk
# or: bun add @railforge/sdk
# or: pnpm add @railforge/sdk
```

## Quickstart

```typescript
import { RailForge } from "@railforge/sdk";

const rf = new RailForge({
  apiKey: "rf_test_your_key_here",
  network: "testnet", // 'testnet' | 'mainnet'
});

const account = await rf.accounts.create({ label: "treasury" });
console.log(account.address);
```

### Custom base URL

For local development against a self-hosted API node:

```typescript
const rf = new RailForge({
  apiKey: "rf_test_abc",
  baseUrl: "http://localhost:3000",
});
```

### Auto-idempotency

Every state-changing call generates a fresh `Idempotency-Key` via `crypto.randomUUID()` before sending. To retry with the _same_ key (so the server replays the cached response instead of running the handler again), pass it explicitly:

```typescript
await rf.payments.send(
  { source: "rSrc...", destination: "rDst...", amount_drops: "1000000" },
  { idempotencyKey: "my-retry-key-2026-04-22-01" },
);
```

## Resource clients

The `RailForge` class exposes nine resource clients: `accounts`, `agents`, `tokens`, `payments`, `credentials`, `domains`, `permissions`, `dex`, `webhooks`.

### `rf.accounts`

```typescript
// Create
const account = await rf.accounts.create({ label: "treasury" });

// Get
const info = await rf.accounts.get("rAddress...");

// Live on-ledger balances (XRP + trust lines + MPTs)
const balances = await rf.accounts.balances("rAddress...");

// List credentials held by this account
const { data, pagination } = await rf.accounts.listCredentials("rAddress...", {
  limit: 50,
  offset: 0,
});

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

// Delete (sweeps balance to destination)
await rf.accounts.delete("rAddress...", { destination: "rDest..." });
```

### `rf.tokens`

```typescript
// Issue an MPT (default)
const token = await rf.tokens.create({
  issuer: "rIssuer...",
  currency_code: "USD",
  transfer_fee: 0,
  clawback: true,
});

// Issue a trust-line token
const ttoken = await rf.tokens.create({
  issuer: "rIssuer...",
  type: "trustline",
  currency_code: "USD",
  trustline_limit: "1000000",
});

// Transfer from issuer to holder
await rf.tokens.transfer(token.id, {
  destination: "rHolder...",
  amount: "1000.00",
});

// Freeze / unfreeze (MPT only)
await rf.tokens.freeze(token.id, { unfreeze: false });

// Clawback
await rf.tokens.clawback(token.id, {
  holder: "rHolder...",
  amount: "500.00",
});
```

### `rf.payments`

```typescript
// XRP
const xrp = await rf.payments.send({
  source: "rSender...",
  destination: "rRecipient...",
  amount_drops: "1000000",
});

// MPT
await rf.payments.send({
  source: "rSender...",
  destination: "rRecipient...",
  mpt_issuance_id: "00000001A4...",
  value: "100.00",
});

// Issued currency (also cross-currency — rippled auto-finds paths)
await rf.payments.send({
  source: "rSender...",
  destination: "rRecipient...",
  currency: "EUR",
  issuer: "rIssuer...",
  value: "50.00",
});

// Check status
const payment = await rf.payments.get("tx_a1c3...");
// payment.status : 'queued' | 'submitting' | 'submitted' | 'validated' | 'failed'

// Batch (sequential fallback for XLS-56)
const batch = await rf.payments.batch({
  mode: "UNTIL_FAILURE",
  payments: [
    { source: "rSrc...", destination: "rA...", amount_drops: "100000" },
    { source: "rSrc...", destination: "rB...", amount_drops: "200000" },
  ],
});

// Escrow
await rf.payments.createEscrow({
  source: "rSender...",
  destination: "rRecipient...",
  amount_drops: "5000000",
  finish_after: 788_745_600,
});
```

### `rf.credentials`

```typescript
// Issue
const cred = await rf.credentials.issue({
  issuer_address: "rIssuer...",
  subject_address: "rSubject...",
  credential_type: "4B5943",
  expiration: 788_745_600,
});

// Subject accepts
await rf.credentials.accept(cred.id, { subject_address: "rSubject..." });

// Synchronous verify — does subject hold a valid accepted credential?
const verified = await rf.credentials.verify({
  subject_address: "rSubject...",
  issuer_address: "rIssuer...",
  credential_type: "4B5943",
});
if (verified.valid) {
  console.log(verified.credential_id);
}

// Revoke (issuer or subject)
await rf.credentials.revoke(cred.id);
```

### `rf.domains`

```typescript
// Create a permissioned domain
const domain = await rf.domains.create({
  owner_address: "rOwner...",
  accepted_credentials: [
    { issuer: "rIssuer1...", credential_type: "4B5943" },
    { issuer: "rIssuer2...", credential_type: "4B5943" },
  ],
});

// Get
await rf.domains.get(domain.id);

// Update the accepted-credentials list (replaces, doesn't append)
await rf.domains.update(domain.id, {
  accepted_credentials: [{ issuer: "rIssuer1...", credential_type: "4B5943" }],
});

// Members (paginated)
const { data } = await rf.domains.listMembers(domain.id);

// Synchronous membership check
const check = await rf.domains.checkMembership(domain.id, {
  subject_address: "rSubject...",
});
console.log(check.qualifies);

// Delete
await rf.domains.delete(domain.id);
```

### `rf.permissions`

```typescript
// Grant — pre-V1.1 maps to signer-list + role
const delegation = await rf.permissions.grant({
  delegator_address: "rDelegator...",
  delegate_address: "rDelegate...",
  permissions: ["Payment", "TrustSet"],
  weight: 1,
  // quorum omitted → defaults to 1 (any single delegate signs).
  // For 2-of-2 coordination, grant both, then set quorum: 2 on the second grant.
});

// List active delegations
const { data } = await rf.permissions.list("rDelegator...");

// Revoke
await rf.permissions.revoke("rDelegator...", "rDelegate...", {
  delegator_address: "rDelegator...",
});

// Audit log
const audit = await rf.permissions.audit("rDelegator...");
```

### `rf.agents`

```typescript
// Provision a payment agent — generates the delegate keypair, queues the
// SignerListSet, installs the spend policy, and writes the allowlist in one call.
const agent = await rf.agents.provision({
  preset: "payment-agent",
  parent_address: "rParent...",
  label: "supplier-payouts",
  allowlist: [
    { entry_type: "destination", entry_value: "rSupplierA..." },
    { entry_type: "destination", entry_value: "rSupplierB..." },
  ],
  // Optional override; preset defaults to 10 XRP per tx, 100 XRP per day.
  spend_policy: { max_xrp_per_tx_drops: "5000000" },
});

// CRITICAL: persist agent.agent_seed before this scope exits — it's the
// only copy the SDK ever sees, redacted at every log boundary, and never
// returned by subsequent reads.
saveSeedSomewhereSafe(agent.agent_seed);

// Poll until the grant tx validates.
let view = await rf.agents.get(agent.id);
while (view.status === "pending") {
  await new Promise((r) => setTimeout(r, 1000));
  view = await rf.agents.get(agent.id);
}

// List agents for the active client.
const { data } = await rf.agents.list();

// Stage revocation. The agent enters 'revoking' immediately and flips to
// 'revoked' once the SignerListSet validates (or back to 'active' if the
// tx fails). Subscribe to the 'agent.revoked' webhook for the terminal flip.
await rf.agents.revoke(agent.id);
```

To bind an API key to this agent so its calls are gated automatically, mint it from the dashboard with `agent_id` set, or via `POST /v1/dashboard/keys`. Once bound, `rf.payments.send` calls from that key are restricted to allowlisted destinations and tokens — off-allowlist returns 400 before any tx is enqueued. See the [Agents API reference](/api/agents/) for the enforcement details.

### `rf.dex`

```typescript
// Create an offer
await rf.dex.createOffer({
  account: "rMaker...",
  taker_gets: { drops: "1000000" },
  taker_pays: { currency: "USD", issuer: "rIssuer...", value: "10" },
});

// Cancel
await rf.dex.cancelOffer(123, {
  account: "rMaker...",
  offer_sequence: 123,
});

// AMM deposit (two-asset mode)
await rf.dex.ammDeposit({
  account: "rLP...",
  asset: { drops: "0" },
  asset2: { currency: "USD", issuer: "rIssuer..." },
  amount: { drops: "1000000" },
  amount2: { currency: "USD", issuer: "rIssuer...", value: "10" },
});

// AMM withdraw (LP-tokens-in mode)
await rf.dex.ammWithdraw({
  account: "rLP...",
  asset: { drops: "0" },
  asset2: { currency: "USD", issuer: "rIssuer..." },
  lp_token_in: {
    currency: "03A4F9...",
    issuer: "rAMMAccount...",
    value: "100",
  },
});
```

### `rf.webhooks`

```typescript
// Create endpoint
const endpoint = await rf.webhooks.create({
  url: "https://your-app.com/hooks",
  events: ["transaction.validated", "credential.issued"],
});
console.log(endpoint.secret); // Save this — never returned again.

// List
const { data } = await rf.webhooks.list();

// Rotate secret (returns whsec_… once)
const rotated = await rf.webhooks.rotateSecret(endpoint.id);

// Delete
await rf.webhooks.delete(endpoint.id);
```

## Cookie session (for first-party dashboards)

If you're embedding the SDK in a browser dashboard and don't want the API key in JavaScript, use cookie auth instead of `apiKey`:

```typescript
const rf = new RailForge({
  baseUrl: "https://api.railforge.dev",
  useCookieSession: true, // sends credentials: 'include' on every request
});

// One-time login (stamps the httpOnly cookie server-side)
await rf.session.login("rf_test_...");

// Every subsequent call uses the cookie automatically
await rf.accounts.create({ label: "treasury" });

// Logout clears the cookie
await rf.session.logout();
```

The `SameSite=Strict` cookie blocks cross-origin requests — this is the modern CSRF defense. If your integration needs cross-site flows, work around it explicitly rather than downgrading to `Lax`.

## Error handling

All API errors throw a `RailForgeError` carrying the HTTP status and the raw response body. Match on `err.status` for branching:

```typescript
import { RailForgeError } from "@railforge/sdk";

try {
  await rf.accounts.get("rInvalid");
} catch (err) {
  if (err instanceof RailForgeError) {
    switch (err.status) {
      case 401: // API key invalid / revoked
      case 403: // env mismatch or privilege deny (e.g. cross-env key mint)
      case 404: // resource not found (also used for cross-tenant 404s)
      case 409: // idempotency conflict — retry
      case 429: // rate limited — back off and retry
      case 503: // DB / upstream unavailable — retry
      default:
        console.log(err.status, err.body);
    }
  }
  throw err;
}
```

## Webhook verification

The SDK ships a helper that encodes the correct v1 scheme (`HMAC-SHA256(secret, timestamp + "." + body)`) plus the 5-minute replay window. See [Webhooks › Verifying webhook signatures](/api/webhooks/#verifying-webhook-signatures) for the exact implementation if you're not using the SDK on the receiver side.

```typescript
import { verifyWebhook } from "@railforge/sdk";

// In your Express/Hono/Elysia handler:
const ok = verifyWebhook({
  rawBody: req.rawBody, // the exact bytes, not the parsed JSON
  signature: req.headers["x-railforge-signature"],
  timestamp: req.headers["x-railforge-timestamp"],
  version: req.headers["x-railforge-webhook-version"],
  secret: process.env.RAILFORGE_WEBHOOK_SECRET,
});
if (!ok) return res.status(400).send("invalid signature");
```
