// Drizzle schema definitions. Mirror PLAN.md §3 SQL — but DRIZZLE is the
// source of truth, the SQL in PLAN.md is reference.
//
// CRITICAL: never edit migration files under src/migrations/ that
// are tracked in git. Generate a new one with `bun run db:generate`. The
// migration-immutable hook will block edits to applied migrations.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ── Platform ─────────────────────────────────────────────────────────────────

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  label: text('label'),
  environment: text('environment').notNull().default('testnet'),
  rateLimit: integer('rate_limit').notNull().default(100),
  // notNull so the SQL filter `eq(isActive, true)` always evaluates to a
  // boolean — never NULL, which would silently exclude rows from auth lookups
  // and produce hard-to-debug auth failures.
  isActive: boolean('is_active').notNull().default(true),
  // VISION.md agent launcher: when non-null, this API key is bound to a
  // specific agent (sub-account of a managed parent). The auth middleware
  // sets ctx.agentId and the payment / DEX services gate against the
  // agent's allowlist + status. NULL for regular client-scoped keys.
  // FK is `() => agents.id` (lazy lambda) because `agents` is declared
  // further down in this file and a direct reference would be a forward-
  // reference TDZ error. ON DELETE SET NULL: deleting an agent
  // un-binds its keys rather than orphaning them or cascading the
  // deletion to keys (which the auth path would then reject anyway).
  agentId: uuid('agent_id').references(() => agents.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: text('events').array().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ── Accounts ─────────────────────────────────────────────────────────────────

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    address: text('address').notNull().unique(),
    masterKeyRef: text('master_key_ref').notNull(),
    regularKey: text('regular_key'),
    custodyMode: text('custody_mode').notNull().default('semi'),
    label: text('label'),
    isFunded: boolean('is_funded').default(false),
    reserveBalance: text('reserve_balance').default('0'),
    // Treasury-funded creation (Sprint 3): the ID of the Payment tx that
    // funds this account from the treasury wallet. NULL for accounts
    // created outside the treasury flow (e.g. imported non-custodial).
    // The txConfirmer joins on this column to flip is_funded=true when
    // the funding payment validates on-ledger.
    fundingTxId: uuid('funding_tx_id'),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    clientIdx: index('idx_accounts_client').on(t.clientId),
    // Hot path: txConfirmer looks up "which account does this validated
    // payment fund?" by tx id. Without an index that's a seq scan on
    // every tesSUCCESS.
    fundingTxIdx: index('idx_accounts_funding_tx').on(t.fundingTxId),
  }),
);

export const signerLists = pgTable('signer_lists', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  quorum: integer('quorum').notNull(),
  // Array of {address, weight}. See PLAN.md §3.2.
  signers: jsonb('signers').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ── Tokens ───────────────────────────────────────────────────────────────────

export const tokens = pgTable('tokens', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  issuerAccount: uuid('issuer_account')
    .notNull()
    .references(() => accounts.id),
  // 'mpt' (default) or 'trustline'. Design rule: MPT by default.
  tokenType: text('token_type').notNull().default('mpt'),
  currencyCode: text('currency_code').notNull(),
  mptIssuanceId: text('mpt_issuance_id'),
  // Basis points (0-50000)
  transferFee: integer('transfer_fee').default(0),
  clawback: boolean('clawback').default(true),
  freezeEnabled: boolean('freeze_enabled').default(true),
  maxSupply: text('max_supply'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ── Credentials (XLS-70) ─────────────────────────────────────────────────────
// design rule: RailForge is NEVER the credential issuer — only a
// marketplace broker. issuer_address comes from credential_issuers.

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    subjectAddress: text('subject_address').notNull(),
    issuerAddress: text('issuer_address').notNull(),
    // Hex-encoded credential type (up to 64 bytes per XLS-70)
    credentialType: text('credential_type').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** Dedup marker for credential.expiring webhook sweeps (PLAN.md §9.1 #19). */
    lastExpiryAlertAt: timestamp('last_expiry_alert_at', {
      withTimezone: true,
    }),
    ledgerIndex: text('ledger_index'),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    subjectIdx: index('idx_credentials_subject').on(t.subjectAddress),
    issuerIdx: index('idx_credentials_issuer').on(t.issuerAddress),
  }),
);

export const credentialIssuers = pgTable('credential_issuers', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  address: text('address').notNull(),
  // 'sumsub' | 'veriff' | 'synaps' | etc.
  provider: text('provider').notNull(),
  // Credential types this issuer supports (hex-encoded)
  types: text('types').array().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ── Permission delegations (XLS-75 V1.1 pending) ─────────────────────────────

export const delegations = pgTable('delegations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  delegatorAddress: text('delegator_address').notNull(),
  delegateAddress: text('delegate_address').notNull(),
  // Array of XLS-75 permission strings
  permissions: text('permissions').array().notNull(),
  /** Signer weight for this delegate on the signer list. */
  weight: integer('weight').notNull().default(1),
  status: text('status').notNull().default('active'),
  // REVIEW.md C-1: staging slot for in-flight revocations. revokePermission
  // sets this to true instead of mutating `status`; the txConfirmer commits
  // (status='revoked', revokedAt=now) on tesSUCCESS or clears the flag on
  // failure/expiry. A row with pendingRevocation=true rejects further
  // revoke attempts (one revoke in flight at a time).
  pendingRevocation: boolean('pending_revocation').notNull().default(false),
  ledgerIndex: text('ledger_index'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

// ── Permissioned Domains (XLS-80) ────────────────────────────────────────────

export const domains = pgTable('domains', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  ownerAddress: text('owner_address').notNull(),
  domainId: text('domain_id').notNull().unique(),
  // [{issuer, credential_type}] — up to 10 per domain (protocol limit)
  acceptedCredentials: jsonb('accepted_credentials').notNull(),
  // Sprint 7 (#22): staging slots for in-flight mutations. updateDomain
  // writes the proposed new list to pendingAcceptedCredentials instead of
  // mutating acceptedCredentials; deleteDomain sets pendingDeletion=true
  // instead of stamping deletedAt. The txConfirmer commits on validation
  // or clears the staging field on failure so the DB never diverges from
  // the on-chain state. A row with any pending flag rejects further
  // update/delete requests (one mutation in flight at a time).
  pendingAcceptedCredentials: jsonb('pending_accepted_credentials'),
  pendingDeletion: boolean('pending_deletion').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// ── Transactions ─────────────────────────────────────────────────────────────
// Per PLAN.md §3.7: idempotency is enforced via UNIQUE(client_id, idempotency_key).

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    // REVIEW.md HIGH-04: NOT NULL is load-bearing. Postgres treats every NULL
    // as distinct under UNIQUE(client_id, idempotency_key), so a NULL here
    // silently bypasses the DB-layer idempotency guard. Every service that
    // inserts into this table MUST thread `c.req.header('idempotency-key')`
    // through — middleware enforces the header is present on all
    // POST/PUT/DELETE. Migration 0012 backfilled legacy NULLs with
    // `legacy-<row-id>` before setting NOT NULL.
    idempotencyKey: text('idempotency_key').notNull(),
    txType: text('tx_type').notNull(),
    sourceAddress: text('source_address').notNull(),
    // REVIEW.md L-2: this column MUST stay NULL. The txSubmitter
    // intentionally does NOT persist signed blobs (verified by the
    // integration test invariant "txBlob is null"). The column exists
    // for potential future forensic use only. If you're tempted to
    // populate it "for debugging," don't — tx_blob is signature
    // material and has no business sitting in Postgres long-term.
    txBlob: text('tx_blob'),
    txHash: text('tx_hash'),
    status: text('status').notNull().default('queued'),
    resultCode: text('result_code'),
    ledgerIndex: bigint('ledger_index', { mode: 'number' }),
    feeDrops: text('fee_drops'),
    requestBody: jsonb('request_body').notNull(),
    responseBody: jsonb('response_body'),
    errorMessage: text('error_message'),
    // Sprint 7 (#15): XRP amount in drops for this transaction, if
    // applicable. Used by the spend-policy daily-limit aggregation
    // (`SUM(amount_drops::bigint) WHERE created_at > now() - 24h`).
    // NULL for non-XRP or zero-value transactions (credentials,
    // domains, permissions, key rotations, etc.).
    amountDrops: text('amount_drops'),
    // USD-denominated amount stamped at enforcement time (migration 0020).
    // Set when enforceSpendPolicy was called: drops × XRP/USD rate ÷ 1M
    // for XRP, or value × 100 for RLUSD. NULL for non-policy-checked txs
    // (MPT, non-RLUSD IOU, zero-value system txs). Used by txConfirmer's
    // refund path so it can decrement the cents counter directly without
    // rerunning the oracle.
    amountUsdCents: text('amount_usd_cents'),
    // VISION.md agent launcher: when non-null, this tx was submitted by an
    // agent-bound API key (ctx.agentId set in payment.service). Powers the
    // per-agent tx history view on the dashboard. ON DELETE SET NULL so a
    // future agent purge doesn't cascade into transaction-history loss.
    // FK uses `() => agents.id` (lazy) because `agents` is declared below
    // and a direct ref would be a forward-reference TDZ error.
    agentId: uuid('agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => ({
    idempotencyUnique: unique('uniq_client_idempotency').on(t.clientId, t.idempotencyKey),
    // PLAN.md §3.7 lists this as a separate INDEX in addition to the UNIQUE
    // constraint above. The UNIQUE constraint creates an implicit index that
    // covers equality lookups, but we materialize the named index explicitly
    // so the schema mirrors the design doc exactly and so future query
    // analyzers can target it by name.
    idempotencyIdx: index('idx_transactions_idempotency').on(t.clientId, t.idempotencyKey),
    clientStatusIdx: index('idx_transactions_client_status').on(t.clientId, t.status),
    hashIdx: index('idx_transactions_hash').on(t.txHash),
    // Per-agent history query: WHERE agent_id=$1 ORDER BY created_at DESC.
    agentCreatedIdx: index('idx_transactions_agent_created').on(t.agentId, t.createdAt),
  }),
);

// ── Audit log ───────────────────────────────────────────────────────────────
// PLAN.md §9.2 #2: every state-changing /v1/* call is logged here.

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    ip: text('ip'),
    requestHash: text('request_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    clientIdx: index('idx_audit_log_client').on(t.clientId, t.createdAt),
    apiKeyIdx: index('idx_audit_log_api_key').on(t.apiKeyId, t.createdAt),
  }),
);

// ── Spend policies (Sprint 7 #15) ───────────────────────────────────────────
// Per-client transaction amount limits. NULL on a limit column means
// "no limit" (unlimited). Clients without a row are also unlimited —
// policies are opt-in, applied by ops or programmatically at tier upgrade.
//
// Limits are XRP-only (in drops) for Sprint 7. Token amount limits
// require an oracle/price-feed, deferred to a later sprint.

// VISION.md agent launcher — per-agent caps. A row with agent_id IS NULL is
// the tenant-wide default (the original Sprint 7 behavior). A row with
// agent_id set is an override for that specific agent. Resolution:
//   agent row exists → use its caps + the agent's own Redis counter
//   else            → use the client row + the client's Redis counter
//   else            → unlimited
//
// UNIQUE(client_id, agent_id) NULLS NOT DISTINCT enforces "exactly one
// tenant-wide row per client" AND "at most one row per (client, agent)"
// in a single constraint — see migration 0018 for the raw SQL since
// Drizzle's `.unique()` doesn't emit NULLS NOT DISTINCT yet.
export const spendPolicies = pgTable(
  'spend_policies',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    agentId: uuid('agent_id').references(() => agents.id, {
      onDelete: 'cascade',
    }),
    // USD-denominated caps (migration 0019). Both XRP and RLUSD payments
    // are converted to cents at enforcement time:
    //   - XRP   → drops × XRP/USD rate (CoinGecko, 60s cache) ÷ 1_000_000
    //   - RLUSD → value × 100 (1:1 peg, no oracle needed)
    //   - other IOU / MPT → out of scope, gated by enforceTokenOpCount instead
    // Stored as text to avoid JS-number precision loss on large caps.
    maxPerTxUsdCents: text('max_per_tx_usd_cents'),
    dailyLimitUsdCents: text('daily_limit_usd_cents'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    // The composite scope index: lookup is "find the policy for
    // (client, agent)" and falls back to "find the policy for
    // (client, NULL)". A B-tree on (client_id, agent_id) covers both.
    scopeIdx: index('idx_spend_policies_scope').on(t.clientId, t.agentId),
  }),
);

// ── Agent launcher (VISION.md) ───────────────────────────────────────────────
// An "agent" is a delegated sub-account of a parent managed account. The
// parent account holds funds via HSM-custodied master key; the agent gets
// its own delegate keypair (XLS-75 V1.1 when live, multi-sign fallback until
// then). Agent-scoped guardrails — destination/token/domain allowlist,
// per-agent spend policy — are enforced in the service layer (payment.service,
// dex.service) by reading ctx.agentId off the request and gating against
// these tables. Status drives revocationCheck: paused/revoked agents can't
// move money even if their API key is still active.
//
// Ownership model:
//   clients → accounts (parent) → agents (sub) → delegations (on-ledger ref)
//
// The `delegation_id` column is nullable so provisioning can insert the
// agent row first, then populate the FK once the permission.service grant
// returns. If the grant fails, the agent row stays with status='pending'
// and the orphan reconciler cleans it up.

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    parentAccountId: uuid('parent_account_id')
      .notNull()
      .references(() => accounts.id),
    agentAddress: text('agent_address').notNull().unique(),
    delegationId: uuid('delegation_id').references(() => delegations.id),
    // Preset name (e.g. 'payment-agent', 'treasury-agent') — references the
    // static preset registry in apps/api/src/presets/agent-presets.ts. Not
    // FK'd because presets are code-defined, not DB rows.
    preset: text('preset').notNull(),
    label: text('label'),
    status: text('status').notNull().default('pending'),
    // VISION.md agent launcher revocation: staging slot mirroring the
    // delegations.pending_revocation pattern (REVIEW.md C-1). DELETE
    // /v1/agents/:id sets this true + queues a SignerListSet that strips
    // the delegate; txConfirmer.applyDelegationRevocationOutcome commits
    // (status='revoked', revokedAt=now, pendingRevocation=false) on
    // tesSUCCESS or clears the flag on failure/expiry. While true, repeat
    // revoke calls are rejected (one revocation in flight at a time).
    pendingRevocation: boolean('pending_revocation').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    clientIdx: index('idx_agents_client').on(t.clientId),
    parentIdx: index('idx_agents_parent').on(t.parentAccountId),
  }),
);

// agent_allowlists is the on-platform equivalent of MultiClaw's protocol
// allowlist: which destinations / tokens / domains this agent is permitted
// to interact with. Service-layer enforcement (not middleware) because the
// decision depends on the parsed body (destination, asset). entry_type:
//   - 'destination' → XRPL r-address (Payment destination)
//   - 'token'       → MPT issuance ID OR `currency:issuer` for IOU
//   - 'domain'      → XLS-80 DomainID (for Permissioned DEX offers)
export const agentAllowlists = pgTable(
  'agent_allowlists',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    entryType: text('entry_type').notNull(),
    entryValue: text('entry_value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    agentIdx: index('idx_agent_allowlist_agent').on(t.agentId),
    uniq: unique('uniq_agent_allowlist').on(t.agentId, t.entryType, t.entryValue),
  }),
);

// ── Indexer state ────────────────────────────────────────────────────────────
// Tables written exclusively by the indexer process. These are derived
// views of on-ledger state — the ledger is authoritative, these rows are
// only convenient for SQL. Idempotency is the single load-bearing
// correctness property: rippled can (and will) replay validated ledgers
// after a reconnect, so every indexer write must be keyed on tx_hash
// (or a composite that the ledger itself guarantees unique).

// processedTransactions is the dedup gate. Every indexed transaction
// writes its hash here first with ON CONFLICT DO NOTHING — if the insert
// returned zero rows, the tx was already processed and the downstream
// UPSERTs are skipped.
export const processedTransactions = pgTable(
  'processed_transactions',
  {
    txHash: text('tx_hash').primaryKey(),
    ledgerIndex: bigint('ledger_index', { mode: 'number' }).notNull(),
    txType: text('tx_type').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    ledgerIdx: index('idx_processed_tx_ledger').on(t.ledgerIndex),
  }),
);

// accountBalances stores per-(address, asset) balance snapshots derived
// from validated Payment / MPTokenAuthorize meta. assetKind='xrp' uses
// assetKey='XRP'; assetKind='iou' uses assetKey='<currency>:<issuer>';
// assetKind='mpt' uses assetKey='<mpt_issuance_id>'. The composite
// unique makes UPSERTs trivial.
export const accountBalances = pgTable(
  'account_balances',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    address: text('address').notNull(),
    assetKind: text('asset_kind').notNull(),
    assetKey: text('asset_key').notNull(),
    balance: text('balance').notNull().default('0'),
    ledgerIndex: bigint('ledger_index', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    addressIdx: index('idx_account_balances_address').on(t.address),
    assetUnique: unique('uniq_balance_address_asset').on(t.address, t.assetKind, t.assetKey),
  }),
);

// offerBook stores open DEX offers for orderbook reads. Keyed by
// (account, sequence) which uniquely identifies an offer on-chain.
// taker_pays / taker_gets are stored as JSONB to handle both XRP
// (string drops) and issued-currency ({currency, issuer, value}) shapes.
export const offerBook = pgTable(
  'offer_book',
  {
    account: text('account').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    takerPays: jsonb('taker_pays').notNull(),
    takerGets: jsonb('taker_gets').notNull(),
    // Derived pair key: canonical `${base}_${counter}` sorted so both
    // sides of an orderbook query hit the same index regardless of order.
    pairKey: text('pair_key').notNull(),
    domainId: text('domain_id'),
    ledgerIndex: bigint('ledger_index', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    pk: unique('pk_offer_account_sequence').on(t.account, t.sequence),
    pairIdx: index('idx_offer_pair').on(t.pairKey),
  }),
);

// ammPools stores AMM pool state keyed by the unordered asset pair.
// assetKey fields follow the same convention as accountBalances.
export const ammPools = pgTable(
  'amm_pools',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    asset1Kind: text('asset1_kind').notNull(),
    asset1Key: text('asset1_key').notNull(),
    asset2Kind: text('asset2_kind').notNull(),
    asset2Key: text('asset2_key').notNull(),
    asset1Balance: text('asset1_balance').notNull().default('0'),
    asset2Balance: text('asset2_balance').notNull().default('0'),
    lpTokenBalance: text('lp_token_balance').notNull().default('0'),
    tradingFee: integer('trading_fee').notNull().default(0),
    ledgerIndex: bigint('ledger_index', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    pairUnique: unique('uniq_amm_pair').on(t.asset1Kind, t.asset1Key, t.asset2Kind, t.asset2Key),
  }),
);

// ── Webhook deliveries ───────────────────────────────────────────────────────

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    responseCode: integer('response_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    statusIdx: index('idx_webhook_deliveries_status').on(t.status, t.createdAt),
  }),
);

// ── x402 (Sprint 10) ─────────────────────────────────────────────────────────
// HTTP 402 payment-required intents and per-client gated route registry.
// SPRINT_10_PLAN.md §3. Intent ids follow the format `x402_intent_<26-base32>`.
// `destination_tag` is XRPL uint32 (CRC32 of intent_id mod 0xFFF00000) — fits
// outside signed int32 range, hence bigint. Amounts stored as text to mirror
// every other XRPL amount column (drops for XRP; raw MPT units otherwise).

export const x402Intents = pgTable(
  'x402_intents',
  {
    id: text('id').primaryKey(),
    // NULL allowed: Mode B clients may issue anonymous intents (no API key
    // bound to the payer). Mode A always sets this to the RailForge client.
    clientId: uuid('client_id').references(() => clients.id),
    resourcePath: text('resource_path').notNull(),
    payeeAddress: text('payee_address').notNull(),
    // 'xrp' | 'mpt'. IOU/trust-line settlement is explicitly out of scope
    // this sprint — verifier rejects unknown kinds (SPRINT_10_PLAN §2).
    assetKind: text('asset_kind').notNull(),
    // MPTokenIssuanceID hex for assetKind='mpt'; NULL for XRP.
    assetKey: text('asset_key'),
    amount: text('amount').notNull(),
    destinationTag: bigint('destination_tag', { mode: 'number' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumingTxHash: text('consuming_tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Partial unique index — a single tx hash may not satisfy two intents.
    // Drizzle supports `.where()` on uniqueIndex for partial constraints.
    uniqConsumingTx: uniqueIndex('x402_intents_consuming_tx_hash_uq')
      .on(t.consumingTxHash)
      .where(sql`consuming_tx_hash IS NOT NULL`),
    // Hot path: middleware lookup by (payee, tag) on retry.
    payeeTagIdx: index('x402_intents_payee_tag_idx').on(t.payeeAddress, t.destinationTag),
    // Reaper job sweeps WHERE expires_at < now() - interval.
    expiresIdx: index('x402_intents_expires_at_idx').on(t.expiresAt),
  }),
);

export const x402Routes = pgTable(
  'x402_routes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    pathPattern: text('path_pattern').notNull(),
    payeeAddress: text('payee_address').notNull(),
    assetKind: text('asset_kind').notNull(),
    assetKey: text('asset_key'),
    priceAmount: text('price_amount').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqClientPath: unique('x402_routes_client_path_uq').on(t.clientId, t.pathPattern),
  }),
);
