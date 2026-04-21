// HSM account setup worker (Phase 2).
//
// When HSM_PROVIDER=aws_cloudhsm, the API can't generate a keypair itself
// (the private key must never leave the HSM). Instead:
//
//   1. API inserts a placeholder accounts row (address/masterKeyRef = 'pending')
//   2. API enqueues this ACCOUNT_SETUP job
//   3. This worker:
//      a. Calls signer.generateInHsm() → gets { address, keyHandle }
//      b. Updates the accounts row with the real address + keyHandle
//      c. Builds the treasury funding Payment
//      d. Inserts a queued transactions row
//      e. Enqueues TX_SUBMIT for the funding tx
//
// On failure the accounts row stays in 'pending' state — the orphan
// reconciler will clean it up after the grace window.

import { db, eq, schema } from '@railforge/db';
import { enqueueTxSubmit } from '@railforge/jobs';
import type { AccountSetupJobData } from '@railforge/jobs';
import { buildXrpPayment } from '@railforge/xrpl-core';
import { type Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../logger.ts';
import { ACCOUNT_SETUP_QUEUE, getSigner } from '../queues.ts';

export async function processAccountSetupJob(job: Job<AccountSetupJobData>): Promise<void> {
  const {
    accountId,
    clientId,
    treasuryAddress,
    fundingAmountDrops,
    custodyMode,
    label,
    idempotencyKey,
  } = job.data;
  const log = logger.child({ job: 'account-setup', accountId, clientId });

  const signer = getSigner();

  // 1. Generate keypair in the HSM.
  if (typeof (signer as { generateInHsm?: unknown }).generateInHsm !== 'function') {
    throw new Error(
      'accountSetup job requires HsmSigner with generateInHsm() — check HSM_PROVIDER',
    );
  }
  const { address, keyHandle } = await (
    signer as unknown as {
      generateInHsm: () => Promise<{ address: string; keyHandle: string }>;
    }
  ).generateInHsm();

  log.info({ address, keyHandle }, 'HSM keypair generated');

  // 2. Update the placeholder accounts row with the real address + label.
  await db
    .update(schema.accounts)
    .set({
      address,
      masterKeyRef: keyHandle,
      custodyMode: custodyMode ?? 'semi',
      label: label ?? null,
    })
    .where(eq(schema.accounts.id, accountId));

  // 3. Build the funding Payment.
  const txJson = buildXrpPayment({
    account: treasuryAddress,
    destination: address,
    amountDrops: fundingAmountDrops,
  });

  // 4. Insert a queued transactions row + link to the account.
  //
  // REVIEW.md HIGH-04: the DB column is NOT NULL. If the job was enqueued
  // before the API was updated to thread the header, fall back to an
  // accountId-derived key so the row still commits. Stable across retries
  // of the same job — the UNIQUE catches a repeated setup attempt.
  const txIdemKey = idempotencyKey ?? `hsm-fund-${accountId}`;
  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId,
      idempotencyKey: txIdemKey,
      txType: 'Payment',
      sourceAddress: treasuryAddress,
      status: 'queued',
      amountDrops: fundingAmountDrops,
      requestBody: {
        purpose: 'account_funding',
        destination: address,
        amountDrops: fundingAmountDrops,
      },
    })
    .returning({ id: schema.transactions.id });

  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  // Link funding tx to the account row.
  await db
    .update(schema.accounts)
    .set({ fundingTxId: txId })
    .where(eq(schema.accounts.id, accountId));

  // 5. Enqueue the funding tx.
  await enqueueTxSubmit({ txId, sourceAddress: treasuryAddress, txJson });

  log.info({ address, txId }, 'HSM account setup complete, funding enqueued');
}

export function startAccountSetupWorker(redis: Redis): Worker<AccountSetupJobData> {
  return new Worker<AccountSetupJobData>(ACCOUNT_SETUP_QUEUE, processAccountSetupJob, {
    connection: redis,
    concurrency: 1,
  });
}
