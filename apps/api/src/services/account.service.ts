// Account service — create and read managed XRPL accounts.
//
// Sprint 3 scope: treasury-funded creation + get by address.
//
// Architecture notes:
//
// - The API process does NOT sign transactions. It (a) generates a wallet,
//   (b) persists the seed into accounts.master_key_ref, (c) inserts a
//   queued Payment tx from the treasury to the new address, (d) enqueues
//   it on the tx-submit queue. The worker signs and submits. The confirmer
//   flips accounts.is_funded=true when the payment validates.
//
// - Treasury funding replaces the direct testnet-faucet call that Sprint 2
//   used. The faucet is a testnet-only path with different error modes;
//   routing through the same txSubmitter pipeline that every other tx uses
//   means account creation exercises the prod sign+submit path from day
//   one. It's also the shape XLS-68 sponsored reserves will take on
//   mainnet — different funding mechanism, same pipeline.
//
// - `master_key_ref` holds the raw xrpl.js seed in dev. Sprint 4+ replaces
//   this with CloudHSM key handles; the column name doesn't change.
//
// - createAccount returns is_funded=false. Clients poll the returned
//   funding_tx_id until the worker confirms the payment (~4s under normal
//   conditions). This is an API contract change from Sprint 2.
//
// SECURITY: this service handles seed material. The seed NEVER leaves this
// file via a return value, log line, or API response. It goes directly into
// the DB column and nowhere else. The logger's REDACT_PATHS list covers
// `*.seed` and `*.master_key_ref` in both snake_case and camelCase — see
// packages/logger/src/index.ts.

import { and, db, eq, isNull, schema } from "@railforge/db";
import { enqueueTxSubmit } from "@railforge/jobs";
import { buildXrpPayment } from "@railforge/xrpl-core";
import { Wallet } from "xrpl";
import { logger } from "../logger.ts";

// Amount sent from the treasury to each new account. 20 XRP covers the
// 10 XRP base reserve with 10 XRP headroom for object reserves (trust
// lines, signer lists, offers) the account may create later. Sprint 4+
// will make this configurable per-client plan.
const FUNDING_AMOUNT_DROPS = "20000000";

export interface CreateAccountInput {
  clientId: string;
  label?: string;
  custodyMode?: "semi" | "non_custodial";
}

export interface AccountView {
  id: string;
  address: string;
  regularKey: string | null;
  custodyMode: string;
  label: string | null;
  isFunded: boolean;
  reserveBalance: string;
  fundingTxId: string | null;
  createdAt: Date | null;
}

export class AccountServiceError extends Error {
  constructor(
    public readonly code:
      | "treasury_not_configured"
      | "enqueue_failed"
      | "not_found"
      | "db_conflict",
    message: string,
  ) {
    super(message);
    this.name = "AccountServiceError";
  }
}

/**
 * Generate a new wallet, persist it, and enqueue a treasury-funded Payment.
 * Returns a redacted AccountView — the seed is NEVER in the response.
 *
 * The returned `isFunded` is always false at creation time. The funding
 * payment is validated asynchronously by the worker; clients poll via
 * GET /v1/accounts/:address to observe the flip.
 *
 * @throws {AccountServiceError} on treasury misconfiguration, DB conflict,
 *   or enqueue failure
 */
export async function createAccount(
  input: CreateAccountInput,
): Promise<AccountView> {
  const log = logger.child({
    service: "account",
    op: "create",
    clientId: input.clientId,
  });

  // 1. Treasury must be configured. The address lives in env because the
  // API process doesn't hold the seed (only the worker does — see
  // apps/worker/src/index.ts). We need the address here to set it as the
  // sourceAddress on the Payment tx.
  const treasuryAddress = process.env.TREASURY_ADDRESS;
  if (!treasuryAddress) {
    throw new AccountServiceError(
      "treasury_not_configured",
      "TREASURY_ADDRESS env var is not set — account creation is disabled",
    );
  }

  // 2. Generate a fresh wallet. Wallet.generate() produces a keypair with
  // a non-null seed; we assert it for the type system.
  const wallet = Wallet.generate();
  if (!wallet.seed) {
    throw new Error("Wallet.generate() returned no seed — should never happen");
  }
  const address = wallet.classicAddress;

  // 3. Build the funding Payment. This is the same builder the token
  // service uses for any XRP payment — treasury funding is just a
  // Payment tx with specific source and destination.
  const txJson = buildXrpPayment({
    account: treasuryAddress,
    destination: address,
    amountDrops: FUNDING_AMOUNT_DROPS,
  });

  // 4. Persist account + transactions row in a single DB transaction.
  //
  // Order matters: we insert the tx row first to get its id, then insert
  // the account row with funding_tx_id already populated. Doing it the
  // other way would require an UPDATE to backfill funding_tx_id, which
  // would leave a brief window where the account row exists without a
  // link to its funding tx. One atomic write is cleaner.
  //
  // If the wallet address collides with an existing row (2^-128 odds,
  // but we handle it cleanly), Postgres returns 23505 which we translate
  // to AccountServiceError('db_conflict').
  let accountId: string;
  let txId: string;
  try {
    const result = await db.transaction(async (tx) => {
      // a. Insert the queued transactions row. sourceAddress is the
      // treasury's address — the worker's signer must hold that key, or
      // the job will fail with SIGNER_NO_KEY at submission time.
      const txInserted = await tx
        .insert(schema.transactions)
        .values({
          clientId: input.clientId,
          txType: "Payment",
          sourceAddress: treasuryAddress,
          status: "queued",
          // request_body is jsonb NOT NULL. Stash enough context for a
          // debugging operator to understand why this tx exists without
          // having to join other tables.
          requestBody: {
            purpose: "account_funding",
            destination: address,
            amountDrops: FUNDING_AMOUNT_DROPS,
          },
        })
        .returning({ id: schema.transactions.id });
      const txRow = txInserted[0];
      if (!txRow) {
        throw new AccountServiceError(
          "db_conflict",
          "transactions insert returned no row",
        );
      }

      // b. Insert the account row, pre-linked to the funding tx. The
      // txConfirmer will flip is_funded=true when the Payment validates.
      const acctInserted = await tx
        .insert(schema.accounts)
        .values({
          clientId: input.clientId,
          address,
          masterKeyRef: wallet.seed as string,
          regularKey: null,
          custodyMode: input.custodyMode ?? "semi",
          label: input.label ?? null,
          isFunded: false,
          reserveBalance: "0",
          fundingTxId: txRow.id,
          metadata: {},
        })
        .returning({ id: schema.accounts.id });
      const acctRow = acctInserted[0];
      if (!acctRow) {
        throw new AccountServiceError(
          "db_conflict",
          "accounts insert returned no row",
        );
      }

      return { accountId: acctRow.id, txId: txRow.id };
    });
    accountId = result.accountId;
    txId = result.txId;
  } catch (err) {
    // Postgres unique-violation — either the wallet address collided
    // (astronomically unlikely) or the idempotency-key unique constraint
    // hit. Treat both as db_conflict; the client retries with a new
    // idempotency key.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      throw new AccountServiceError("db_conflict", "Address collision (retry)");
    }
    throw err;
  }

  // 5. Enqueue the tx-submit job. Done AFTER the DB commit so we never
  // enqueue a job that references an uncommitted row. If the enqueue
  // itself fails (Redis down, BullMQ error), the DB rows exist but no
  // job is queued — an orphan state. A future reconciliation job can
  // sweep orphaned 'queued' rows. For Sprint 3 we surface the failure
  // to the client and accept the orphan; the alternative (rolling back
  // the DB write) would require a second write and doesn't eliminate
  // the race anyway.
  try {
    await enqueueTxSubmit({
      txId,
      sourceAddress: treasuryAddress,
      txJson,
    });
  } catch (err) {
    log.error({ err }, "enqueueTxSubmit failed after DB commit");
    throw new AccountServiceError(
      "enqueue_failed",
      "Failed to enqueue funding transaction — account row exists but is unfunded",
    );
  }

  log.info({ address, txId }, "account created, funding enqueued");

  // 6. Return a redacted view. is_funded is FALSE — the client polls to
  // observe the flip after the worker confirms the payment (~4s).
  return {
    id: accountId,
    address,
    regularKey: null,
    custodyMode: input.custodyMode ?? "semi",
    label: input.label ?? null,
    isFunded: false,
    reserveBalance: "0",
    fundingTxId: txId,
    createdAt: new Date(),
  };
}

/**
 * Look up an account by address, scoped to a client. Returns null if the
 * account doesn't exist OR belongs to a different client — the two cases
 * are indistinguishable to the caller, which is intentional (no cross-
 * tenant enumeration).
 */
export async function getAccount(
  clientId: string,
  address: string,
): Promise<AccountView | null> {
  const rows = await db
    .select({
      id: schema.accounts.id,
      address: schema.accounts.address,
      regularKey: schema.accounts.regularKey,
      custodyMode: schema.accounts.custodyMode,
      label: schema.accounts.label,
      isFunded: schema.accounts.isFunded,
      reserveBalance: schema.accounts.reserveBalance,
      fundingTxId: schema.accounts.fundingTxId,
      createdAt: schema.accounts.createdAt,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.clientId, clientId),
        eq(schema.accounts.address, address),
        isNull(schema.accounts.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    address: row.address,
    regularKey: row.regularKey,
    custodyMode: row.custodyMode,
    label: row.label,
    isFunded: row.isFunded ?? false,
    reserveBalance: row.reserveBalance ?? "0",
    fundingTxId: row.fundingTxId,
    createdAt: row.createdAt,
  };
}
