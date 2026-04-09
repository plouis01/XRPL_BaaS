// End-to-end integration test for the tx-submit pipeline.
//
// What this proves that the unit tests cannot:
//
//   1. The CRITICAL "cold-start lazy load" path works against a REAL signer.
//      The unit test stubs DevSigner.loadKey — this test exercises the
//      actual seed-from-DB → Wallet.fromSeed → register-and-sign chain.
//      A regression that re-broke task #50 would be caught here.
//
//   2. processTxSubmitJob writes to the REAL `accounts` and `transactions`
//      tables via @railforge/db. A schema or column-name drift between the
//      service code and the migrations would manifest here, not in unit tests
//      that mock the db module wholesale.
//
//   3. The signed blob is accepted by REAL rippled — proving the builders +
//      sequencer + signer + submit path is end-to-end correct.
//
// GATING: this file self-skips unless RAILFORGE_TEST_NETWORK=testnet AND
// DATABASE_URL points at a reachable Postgres. CI runs it; local saves
// don't (would burn testnet faucet credits + require docker compose up).
//
// Run with:
//   RAILFORGE_TEST_NETWORK=testnet bun run --filter @railforge/worker test:integration

import { db, eq, schema } from '@railforge/db';
import { buildXrpPayment } from '@railforge/xrpl-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Wallet } from 'xrpl';
import { disconnectWorker, getSigner, getXrplPool } from '../queues.ts';
import type { TxSubmitJobData } from '../queues.ts';
import { processTxSubmitJob } from './txSubmitter.ts';

const SHOULD_RUN = process.env.RAILFORGE_TEST_NETWORK === 'testnet' && !!process.env.DATABASE_URL;

const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

// Disposable test client + account state. Created in beforeAll, cleaned up
// in afterAll so the test doesn't pollute the local DB.
let testClientId: string;
let testAccountId: string;
let fundedWallet: Wallet;
let testTxId: string;

describeOrSkip('txSubmitter end-to-end (testnet + real DB)', () => {
  beforeAll(async () => {
    // 1. Create a disposable client row. We use a UUID-suffixed email so
    // re-runs don't collide on the unique constraint.
    const suffix = Math.random().toString(36).slice(2, 10);
    const inserted = await db
      .insert(schema.clients)
      .values({
        name: 'integration-test-client',
        email: `integration-${suffix}@test.local`,
        plan: 'free',
      })
      .returning({ id: schema.clients.id });
    testClientId = inserted[0]!.id;

    // 2. Faucet-fund a fresh wallet so we have a real on-ledger account
    // with a real Sequence number.
    const faucetRes = await fetch('https://faucet.altnet.rippletest.net/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!faucetRes.ok) {
      throw new Error(`faucet failed: ${faucetRes.status}`);
    }
    const faucetBody = (await faucetRes.json()) as {
      account: { secret?: string };
      seed?: string;
    };
    const seed = faucetBody.account.secret ?? faucetBody.seed;
    if (!seed) throw new Error('faucet returned no seed');
    fundedWallet = Wallet.fromSeed(seed);

    // 3. Wait for the funding tx to land — the faucet returns before
    // validation. Without this, getNextSequence() races the on-ledger
    // state and returns NaN.
    const pool = await getXrplPool();
    const xrplClient = pool.getClient();
    let funded = false;
    for (let i = 0; i < 15; i++) {
      try {
        await xrplClient.request({
          command: 'account_info',
          account: fundedWallet.classicAddress,
          ledger_index: 'current',
        });
        funded = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!funded) throw new Error('faucet-funded account never appeared on-ledger');

    // 4. Persist the account in the DB the way the API service would —
    // including the seed in master_key_ref. CRITICAL: do NOT register the
    // wallet with the in-process signer here. The whole point of this test
    // is to exercise the cold-start lazy-load path in processTxSubmitJob.
    const acctInserted = await db
      .insert(schema.accounts)
      .values({
        clientId: testClientId,
        address: fundedWallet.classicAddress,
        masterKeyRef: seed,
        custodyMode: 'semi',
        isFunded: true,
        reserveBalance: '10000000',
      })
      .returning({ id: schema.accounts.id });
    testAccountId = acctInserted[0]!.id;

    // 5. Insert a queued transactions row that the worker will update.
    const destWallet = Wallet.generate();
    const txInserted = await db
      .insert(schema.transactions)
      .values({
        clientId: testClientId,
        idempotencyKey: `integration-${suffix}`,
        txType: 'Payment',
        sourceAddress: fundedWallet.classicAddress,
        status: 'queued',
        requestBody: { destination: destWallet.classicAddress, amount: '1' },
      })
      .returning({ id: schema.transactions.id });
    testTxId = txInserted[0]!.id;
  }, 60_000);

  afterAll(async () => {
    // Clean up DB rows. Order matters because of FKs: transactions →
    // accounts → clients.
    if (testTxId) {
      await db
        .delete(schema.transactions)
        .where(eq(schema.transactions.id, testTxId))
        .catch(() => {});
    }
    if (testAccountId) {
      await db
        .delete(schema.accounts)
        .where(eq(schema.accounts.id, testAccountId))
        .catch(() => {});
    }
    if (testClientId) {
      await db
        .delete(schema.clients)
        .where(eq(schema.clients.id, testClientId))
        .catch(() => {});
    }
    await disconnectWorker().catch(() => {});
    const { disconnectDb } = await import('@railforge/db');
    await disconnectDb().catch(() => {});
  }, 30_000);

  it('cold-start: processTxSubmitJob loads seed from DB and submits successfully', async () => {
    // Pre-flight: confirm the in-process signer does NOT already hold the key.
    // If this fails, a previous test contaminated the singleton and the test
    // is no longer exercising the cold-start path.
    const signer = getSigner();
    const beforeHasKey = await signer.hasKey(fundedWallet.classicAddress);
    expect(beforeHasKey).toBe(false);

    // Build a real Payment tx the way the token service would.
    const destWallet = Wallet.generate();
    const txJson = buildXrpPayment({
      account: fundedWallet.classicAddress,
      destination: destWallet.classicAddress,
      amountDrops: '1',
    });

    const jobData: TxSubmitJobData = {
      txId: testTxId,
      sourceAddress: fundedWallet.classicAddress,
      // biome-ignore lint/suspicious/noExplicitAny: TxSubmitJobData uses any for the unsigned tx
      txJson: txJson as any,
    };

    // Run the pipeline. processTxSubmitJob should:
    //   - hasKey returns false
    //   - look up master_key_ref from accounts (the seed we persisted)
    //   - call signer.loadKey → DevSigner reconstructs the wallet
    //   - hasKey returns true
    //   - getNextSequence → ledger_current → fill tx → sign → submit
    //   - update transactions row with submitted/failed + result code
    //
    // This is the EXACT path that was broken before task #50.
    await processTxSubmitJob({
      data: jobData,
      id: 'integration-1',
      // biome-ignore lint/suspicious/noExplicitAny: minimal Job stub
    } as any);

    // After processing, the signer should now hold the key.
    const afterHasKey = await signer.hasKey(fundedWallet.classicAddress);
    expect(afterHasKey).toBe(true);

    // The DB row should have transitioned out of 'queued'. Either
    // 'submitted' (tesSUCCESS) or 'failed' (tec*) — both prove the pipeline
    // ran end-to-end. We accept both because the dest is unfunded so
    // tecNO_DST_INSUF_XRP is a valid economic outcome.
    const rows = await db
      .select({
        status: schema.transactions.status,
        resultCode: schema.transactions.resultCode,
        txHash: schema.transactions.txHash,
        txBlob: schema.transactions.txBlob,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, testTxId))
      .limit(1);

    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.status).not.toBe('queued');
    expect(row?.resultCode).toMatch(/^(tes|tec)/);
    expect(row?.txHash).toMatch(/^[A-F0-9]{64}$/);

    // Task #51 invariant: tx_blob is NEVER persisted.
    expect(row?.txBlob).toBeNull();
  }, 60_000);
});
