// End-to-end integration test for the treasury-funded account flow.
//
// What this proves that the unit tests cannot:
//
//   1. The treasury seed loaded via signer.loadKey() actually signs a real
//      Payment that rippled accepts. A regression in DevSigner.loadKey or
//      in the worker startup loading code (apps/worker/src/index.ts) would
//      manifest here as a SIGNER_NO_KEY or sign_failed.
//
//   2. The destination account ACTUALLY receives XRP on-ledger after the
//      payment validates — the funding-pipeline contract end-to-end.
//
//   3. The accounts row's funding_tx_id linkage works as the join key for
//      the txConfirmer's is_funded flip (we don't run the confirmer here,
//      but the schema + index are exercised by an INSERT/SELECT round-trip).
//
// Lives in its own file (not txSubmitter.integration.test.ts) so the
// other test's cold-start-no-key invariant isn't compromised by the
// treasury being pre-loaded into the in-process signer singleton.
//
// GATING: same as the cold-start test — RAILFORGE_TEST_NETWORK=testnet
// AND DATABASE_URL set, otherwise the whole describe block self-skips.
//
// Run with:
//   RAILFORGE_TEST_NETWORK=testnet bun run --filter @railforge/worker test:integration

import { db, eq, schema } from "@railforge/db";
import { buildXrpPayment } from "@railforge/xrpl-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { disconnectWorker, getSigner, getXrplPool } from "../queues.ts";
import type { TxSubmitJobData } from "../queues.ts";
import { processTxSubmitJob } from "./txSubmitter.ts";

const SHOULD_RUN =
  process.env.RAILFORGE_TEST_NETWORK === "testnet" &&
  !!process.env.DATABASE_URL;
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

// Disposable test state. Cleaned up in afterAll.
let testClientId: string;
let treasuryWallet: Wallet;
let destAccountId: string;
let testTxId: string;

describeOrSkip("treasury-funded account creation (testnet + real DB)", () => {
  beforeAll(async () => {
    // 1. Create a disposable client row.
    const suffix = Math.random().toString(36).slice(2, 10);
    const inserted = await db
      .insert(schema.clients)
      .values({
        name: "treasury-integration-test",
        email: `treasury-${suffix}@test.local`,
        plan: "free",
      })
      .returning({ id: schema.clients.id });
    testClientId = inserted[0]!.id;

    // 2. Faucet-fund a fresh "treasury" wallet. In production this is a
    // long-lived pre-funded account loaded from TREASURY_SEED env var; in
    // CI we mint one per run so the test is hermetic and doesn't depend on
    // a stable secret. The faucet gives us 1000 XRP — plenty to fund many
    // accounts in a single test run.
    const faucetRes = await fetch(
      "https://faucet.altnet.rippletest.net/accounts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    if (!faucetRes.ok) {
      throw new Error(`treasury faucet failed: ${faucetRes.status}`);
    }
    const faucetBody = (await faucetRes.json()) as {
      account: { secret?: string };
      seed?: string;
    };
    const seed = faucetBody.account.secret ?? faucetBody.seed;
    if (!seed) throw new Error("faucet returned no seed for treasury");
    treasuryWallet = Wallet.fromSeed(seed);

    // 3. Wait for the treasury account to land on-ledger. The faucet
    // returns before validation; without this wait, the first
    // getNextSequence() call against the treasury would race the ledger.
    const pool = await getXrplPool();
    const xrplClient = pool.getClient();
    let funded = false;
    for (let i = 0; i < 15; i++) {
      try {
        await xrplClient.request({
          command: "account_info",
          account: treasuryWallet.classicAddress,
          ledger_index: "current",
        });
        funded = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!funded) throw new Error("treasury account never appeared on-ledger");

    // 4. Load the treasury into the worker's signer via the same path the
    // worker bootstrap uses (signer.loadKey). This is the bit that
    // apps/worker/src/index.ts does at startup; replicating it here lets
    // the test exercise the same loading code without spawning the worker.
    const signer = getSigner();
    await signer.loadKey(treasuryWallet.classicAddress, seed);
    expect(await signer.hasKey(treasuryWallet.classicAddress)).toBe(true);

    // 5. Generate a destination wallet — this represents a NEW user account
    // that account.service.createAccount would generate. It does NOT exist
    // on-ledger yet; the treasury Payment will create it.
    const destWallet = Wallet.generate();

    // 6. Insert the queued transactions row first, then the account row
    // pre-linked via funding_tx_id — exactly the order account.service does.
    const txInserted = await db
      .insert(schema.transactions)
      .values({
        clientId: testClientId,
        idempotencyKey: `treasury-${suffix}`,
        txType: "Payment",
        sourceAddress: treasuryWallet.classicAddress,
        status: "queued",
        requestBody: {
          purpose: "account_funding",
          destination: destWallet.classicAddress,
          amountDrops: "20000000",
        },
      })
      .returning({ id: schema.transactions.id });
    testTxId = txInserted[0]!.id;

    const acctInserted = await db
      .insert(schema.accounts)
      .values({
        clientId: testClientId,
        address: destWallet.classicAddress,
        // The destination's seed — what account.service would persist.
        // Not used in this test but the schema requires it (NOT NULL).
        masterKeyRef: destWallet.seed as string,
        custodyMode: "semi",
        isFunded: false,
        reserveBalance: "0",
        fundingTxId: testTxId,
      })
      .returning({ id: schema.accounts.id });
    destAccountId = acctInserted[0]!.id;
  }, 90_000);

  afterAll(async () => {
    // Clean up DB rows. Order matters because of FKs: accounts → transactions → clients.
    if (destAccountId) {
      await db
        .delete(schema.accounts)
        .where(eq(schema.accounts.id, destAccountId))
        .catch(() => {});
    }
    if (testTxId) {
      await db
        .delete(schema.transactions)
        .where(eq(schema.transactions.id, testTxId))
        .catch(() => {});
    }
    if (testClientId) {
      await db
        .delete(schema.clients)
        .where(eq(schema.clients.id, testClientId))
        .catch(() => {});
    }
    await disconnectWorker().catch(() => {});
    const { disconnectDb } = await import("@railforge/db");
    await disconnectDb().catch(() => {});
  }, 30_000);

  it("treasury Payment funds a new account on-ledger end-to-end", async () => {
    // Re-derive the destination address from the inserted account row so
    // we don't depend on closed-over state from beforeAll.
    const acctRows = await db
      .select({ address: schema.accounts.address })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, destAccountId))
      .limit(1);
    const destAddress = acctRows[0]!.address;

    // Build the same payment account.service would build.
    const txJson = buildXrpPayment({
      account: treasuryWallet.classicAddress,
      destination: destAddress,
      amountDrops: "20000000",
    });

    const jobData: TxSubmitJobData = {
      txId: testTxId,
      sourceAddress: treasuryWallet.classicAddress,
      // biome-ignore lint/suspicious/noExplicitAny: TxSubmitJobData uses any for the unsigned tx
      txJson: txJson as any,
    };

    // Run the submission pipeline. This signs with the treasury key,
    // submits to rippled, and updates the transactions row.
    await processTxSubmitJob({
      data: jobData,
      id: "treasury-integration-1",
      // biome-ignore lint/suspicious/noExplicitAny: minimal Job stub
    } as any);

    // The transactions row should have transitioned out of 'queued'. We
    // accept either 'submitted' (tesSUCCESS) or 'failed' (tec*) — both
    // prove the pipeline ran end-to-end. tesSUCCESS is the expected path
    // for a treasury payment to a fresh account.
    const txRows = await db
      .select({
        status: schema.transactions.status,
        resultCode: schema.transactions.resultCode,
        txHash: schema.transactions.txHash,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, testTxId))
      .limit(1);
    const txRow = txRows[0];
    expect(txRow).toBeDefined();
    expect(txRow?.status).not.toBe("queued");
    expect(txRow?.resultCode).toBe("tesSUCCESS");
    expect(txRow?.txHash).toMatch(/^[A-F0-9]{64}$/);

    // Most important assertion: the destination account should now exist
    // on-ledger with the funded balance. Poll account_info up to ~30s
    // until the validated ledger reflects it.
    const pool = await getXrplPool();
    const xrplClient = pool.getClient();
    let onLedgerBalance: string | null = null;
    for (let i = 0; i < 15; i++) {
      try {
        const info = (await xrplClient.request({
          command: "account_info",
          account: destAddress,
          ledger_index: "validated",
        })) as { result: { account_data: { Balance: string } } };
        onLedgerBalance = info.result.account_data.Balance;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    expect(onLedgerBalance).not.toBeNull();
    // The faucet-funded treasury sent 20_000_000 drops. After fee
    // deduction on the destination side: 0 (the destination only
    // receives — fees are paid by the sender). So balance should be
    // exactly 20_000_000.
    expect(onLedgerBalance).toBe("20000000");
  }, 90_000);
});
