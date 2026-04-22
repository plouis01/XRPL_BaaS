// End-to-end integration test for the tx-confirm pipeline.
//
// Proves that after a successful txSubmitter run, txConfirmer can:
//   1. Poll rippled's `tx` command until the tx validates on-ledger.
//   2. Update the transactions row to 'validated' with ledger_index.
//   3. Insert webhook_deliveries rows and enqueue delivery jobs.
//
// GATING: self-skips unless RAILFORGE_TEST_NETWORK=testnet AND
// DATABASE_URL points at a reachable Postgres.
//
// Run with:
//   RAILFORGE_TEST_NETWORK=testnet bun run --filter @railforge/worker test:integration

import { db, eq, schema } from '@railforge/db';
import { buildXrpPayment } from '@railforge/xrpl-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Wallet } from 'xrpl';
import { disconnectWorker, getSigner, getXrplPool } from '../queues.ts';
import type { TxConfirmJobData } from '../queues.ts';
import { processTxConfirmJob } from './txConfirmer.ts';
import { processTxSubmitJob } from './txSubmitter.ts';

const SHOULD_RUN = process.env.RAILFORGE_TEST_NETWORK === 'testnet' && !!process.env.DATABASE_URL;
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

let testClientId: string;
let testAccountId: string;
let fundedWallet: Wallet;
let testTxId: string;
let submittedTxHash: string;
let submittedLastLedger: number;
let webhookEndpointId: string;

describeOrSkip('txConfirmer end-to-end (testnet + real DB)', () => {
  beforeAll(async () => {
    const suffix = Math.random().toString(36).slice(2, 10);

    const clientInserted = await db
      .insert(schema.clients)
      .values({
        name: 'confirm-integration-test',
        email: `confirm-int-${suffix}@test.local`,
        plan: 'free',
      })
      .returning({ id: schema.clients.id });
    testClientId = clientInserted[0]!.id;

    // Faucet-fund a wallet.
    const faucetRes = await fetch('https://faucet.altnet.rippletest.net/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!faucetRes.ok) throw new Error(`faucet failed: ${faucetRes.status}`);
    const faucetBody = (await faucetRes.json()) as {
      account: { secret?: string };
      seed?: string;
    };
    const seed = faucetBody.account.secret ?? faucetBody.seed;
    if (!seed) throw new Error('faucet returned no seed');
    fundedWallet = Wallet.fromSeed(seed);

    // Wait for on-ledger appearance.
    const pool = await getXrplPool();
    const xrplClient = pool.getClient();
    for (let i = 0; i < 15; i++) {
      try {
        await xrplClient.request({
          command: 'account_info',
          account: fundedWallet.classicAddress,
          ledger_index: 'current',
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Pre-load key so txSubmitter doesn't need the cold-start path.
    await getSigner().loadKey(fundedWallet.classicAddress, seed);

    // Persist account + transactions row.
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

    // Fund the destination with enough to meet the XRPL base reserve (10 XRP)
    // so the Payment doesn't fail with tecNO_DST_INSUF_XRP. A brand-new
    // destination with a 1-drop payment is guaranteed to trip the reserve.
    const destWallet = Wallet.generate();
    const txJson = buildXrpPayment({
      account: fundedWallet.classicAddress,
      destination: destWallet.classicAddress,
      amountDrops: '10000001',
    });

    const txInserted = await db
      .insert(schema.transactions)
      .values({
        clientId: testClientId,
        idempotencyKey: `confirm-int-${suffix}`,
        txType: 'Payment',
        sourceAddress: fundedWallet.classicAddress,
        status: 'queued',
        requestBody: { destination: destWallet.classicAddress, amount: '1' },
      })
      .returning({ id: schema.transactions.id });
    testTxId = txInserted[0]!.id;

    // Create a webhook endpoint so txConfirmer can fan out.
    const epInserted = await db
      .insert(schema.webhookEndpoints)
      .values({
        clientId: testClientId,
        url: 'https://example.com/webhook-test',
        secret: 'test-secret-integration',
        events: ['transaction.validated', 'transaction.failed'],
        isActive: true,
      })
      .returning({ id: schema.webhookEndpoints.id });
    webhookEndpointId = epInserted[0]!.id;

    // Run txSubmitter to get a real txHash and lastLedger.
    await processTxSubmitJob({
      data: {
        txId: testTxId,
        sourceAddress: fundedWallet.classicAddress,
        txJson,
      },
      id: 'confirm-int-submit',
      attemptsMade: 0,
      opts: { attempts: 3 },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Job stub
    } as any);

    // Read back the submitted state.
    const rows = await db
      .select({
        txHash: schema.transactions.txHash,
        status: schema.transactions.status,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, testTxId))
      .limit(1);
    const row = rows[0];
    if (!row?.txHash || row.status !== 'submitted') {
      throw new Error(`txSubmitter didn't produce a submitted tx: status=${row?.status}`);
    }
    submittedTxHash = row.txHash;

    // Get the lastLedger from the ledger_current to compute a generous horizon.
    const ledgerRes = await xrplClient.request({ command: 'ledger_current' });
    submittedLastLedger = ledgerRes.result.ledger_current_index + 20;
  }, 90_000);

  afterAll(async () => {
    // Clean up in reverse FK order.
    await db
      .delete(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, webhookEndpointId))
      .catch(() => {});
    await db
      .delete(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, webhookEndpointId))
      .catch(() => {});
    if (testTxId)
      await db
        .delete(schema.transactions)
        .where(eq(schema.transactions.id, testTxId))
        .catch(() => {});
    if (testAccountId)
      await db
        .delete(schema.accounts)
        .where(eq(schema.accounts.id, testAccountId))
        .catch(() => {});
    if (testClientId)
      await db
        .delete(schema.clients)
        .where(eq(schema.clients.id, testClientId))
        .catch(() => {});
    await disconnectWorker().catch(() => {});
    const { disconnectDb } = await import('@railforge/db');
    await disconnectDb().catch(() => {});
  }, 30_000);

  it('polls until validated and fans out webhook deliveries', async () => {
    const jobData: TxConfirmJobData = {
      txId: testTxId,
      txHash: submittedTxHash,
      lastLedger: submittedLastLedger,
    };

    // processTxConfirmJob throws TxNotYetValidated on each retry poll.
    // We loop until it resolves (validated) or exhausts 20 attempts.
    let validated = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await processTxConfirmJob({
          data: jobData,
          id: `confirm-int-poll-${attempt}`,
          attemptsMade: attempt,
          opts: { attempts: 20 },
          // biome-ignore lint/suspicious/noExplicitAny: minimal Job stub
        } as any);
        validated = true;
        break;
      } catch {
        // TxNotYetValidated — wait ~4s and retry.
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    expect(validated).toBe(true);

    // DB row should now be 'validated'.
    const rows = await db
      .select({
        status: schema.transactions.status,
        resultCode: schema.transactions.resultCode,
        ledgerIndex: schema.transactions.ledgerIndex,
        confirmedAt: schema.transactions.confirmedAt,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, testTxId))
      .limit(1);
    const row = rows[0];
    expect(row?.status).toBe('validated');
    expect(row?.resultCode).toMatch(/^(tes|tec)/);
    expect(row?.ledgerIndex).toBeGreaterThan(0);
    expect(row?.confirmedAt).toBeTruthy();

    // Webhook delivery should have been created.
    const deliveries = await db
      .select({
        id: schema.webhookDeliveries.id,
        eventType: schema.webhookDeliveries.eventType,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, webhookEndpointId));
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(
      deliveries.some(
        (d) => d.eventType === 'transaction.validated' || d.eventType === 'transaction.failed',
      ),
    ).toBe(true);
  }, 120_000);
});
