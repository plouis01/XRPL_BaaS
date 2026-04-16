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
    idempotencyKey: text('idempotency_key'),
    txType: text('tx_type').notNull(),
    sourceAddress: text('source_address').notNull(),
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

export const spendPolicies = pgTable('spend_policies', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id)
    .unique(),
  maxXrpPerTxDrops: text('max_xrp_per_tx_drops'),
  dailyXrpLimitDrops: text('daily_xrp_limit_drops'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

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
