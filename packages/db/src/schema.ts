// Drizzle schema definitions. Mirror PLAN.md §3 SQL — but DRIZZLE is the
// source of truth, the SQL in PLAN.md is reference.
//
// CRITICAL (CLAUDE.md): never edit migration files under src/migrations/ that
// are tracked in git. Generate a new one with `bun run db:generate`. The
// migration-immutable hook will block edits to applied migrations.

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  bigint,
  unique,
  index,
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

// TODO Sprint 1+: signer_lists, tokens, credentials, credential_issuers,
// delegations, domains, webhook_deliveries. See PLAN.md §3 for the full schema.
