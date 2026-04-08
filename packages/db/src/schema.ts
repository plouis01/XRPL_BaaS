// Drizzle schema definitions. Mirror PLAN.md §3 SQL — but DRIZZLE is the
// source of truth, the SQL in PLAN.md is reference.
//
// CRITICAL (CLAUDE.md): never edit migration files under src/migrations/ that
// are tracked in git. Generate a new one with `bun run db:generate`. The
// migration-immutable hook will block edits to applied migrations.

import { sql } from "drizzle-orm";
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
} from "drizzle-orm/pg-core";

// ── Platform ─────────────────────────────────────────────────────────────────

export const clients = pgTable("clients", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  label: text("label"),
  environment: text("environment").notNull().default("testnet"),
  rateLimit: integer("rate_limit").notNull().default(100),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  events: text("events").array().notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Accounts ─────────────────────────────────────────────────────────────────

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    address: text("address").notNull().unique(),
    masterKeyRef: text("master_key_ref").notNull(),
    regularKey: text("regular_key"),
    custodyMode: text("custody_mode").notNull().default("semi"),
    label: text("label"),
    isFunded: boolean("is_funded").default(false),
    reserveBalance: text("reserve_balance").default("0"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    clientIdx: index("idx_accounts_client").on(t.clientId),
  }),
);

export const signerLists = pgTable("signer_lists", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  quorum: integer("quorum").notNull(),
  // Array of {address, weight}. See PLAN.md §3.2.
  signers: jsonb("signers").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ── Tokens ───────────────────────────────────────────────────────────────────

export const tokens = pgTable("tokens", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  issuerAccount: uuid("issuer_account")
    .notNull()
    .references(() => accounts.id),
  // 'mpt' (default) or 'trustline'. CLAUDE.md design rule: MPT by default.
  tokenType: text("token_type").notNull().default("mpt"),
  currencyCode: text("currency_code").notNull(),
  mptIssuanceId: text("mpt_issuance_id"),
  // Basis points (0-50000)
  transferFee: integer("transfer_fee").default(0),
  clawback: boolean("clawback").default(true),
  freezeEnabled: boolean("freeze_enabled").default(true),
  maxSupply: text("max_supply"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Credentials (XLS-70) ─────────────────────────────────────────────────────
// CLAUDE.md design rule: RailForge is NEVER the credential issuer — only a
// marketplace broker. issuer_address comes from credential_issuers.

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    subjectAddress: text("subject_address").notNull(),
    issuerAddress: text("issuer_address").notNull(),
    // Hex-encoded credential type (up to 64 bytes per XLS-70)
    credentialType: text("credential_type").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    ledgerIndex: text("ledger_index"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    subjectIdx: index("idx_credentials_subject").on(t.subjectAddress),
    issuerIdx: index("idx_credentials_issuer").on(t.issuerAddress),
  }),
);

export const credentialIssuers = pgTable("credential_issuers", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  address: text("address").notNull(),
  // 'sumsub' | 'veriff' | 'synaps' | etc.
  provider: text("provider").notNull(),
  // Credential types this issuer supports (hex-encoded)
  types: text("types").array().notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Permission delegations (XLS-75 V1.1 pending) ─────────────────────────────

export const delegations = pgTable("delegations", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  delegatorAddress: text("delegator_address").notNull(),
  delegateAddress: text("delegate_address").notNull(),
  // Array of XLS-75 permission strings
  permissions: text("permissions").array().notNull(),
  status: text("status").notNull().default("active"),
  ledgerIndex: text("ledger_index"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// ── Permissioned Domains (XLS-80) ────────────────────────────────────────────

export const domains = pgTable("domains", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  ownerAddress: text("owner_address").notNull(),
  domainId: text("domain_id").notNull().unique(),
  // [{issuer, credential_type}] — up to 10 per domain (protocol limit)
  acceptedCredentials: jsonb("accepted_credentials").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Transactions ─────────────────────────────────────────────────────────────
// Per PLAN.md §3.7: idempotency is enforced via UNIQUE(client_id, idempotency_key).

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    idempotencyKey: text("idempotency_key"),
    txType: text("tx_type").notNull(),
    sourceAddress: text("source_address").notNull(),
    txBlob: text("tx_blob"),
    txHash: text("tx_hash"),
    status: text("status").notNull().default("queued"),
    resultCode: text("result_code"),
    ledgerIndex: bigint("ledger_index", { mode: "number" }),
    feeDrops: text("fee_drops"),
    requestBody: jsonb("request_body").notNull(),
    responseBody: jsonb("response_body"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => ({
    idempotencyUnique: unique("uniq_client_idempotency").on(
      t.clientId,
      t.idempotencyKey,
    ),
    clientStatusIdx: index("idx_transactions_client_status").on(
      t.clientId,
      t.status,
    ),
    hashIdx: index("idx_transactions_hash").on(t.txHash),
  }),
);

// ── Webhook deliveries ───────────────────────────────────────────────────────

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    responseCode: integer("response_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    statusIdx: index("idx_webhook_deliveries_status").on(t.status, t.createdAt),
  }),
);
