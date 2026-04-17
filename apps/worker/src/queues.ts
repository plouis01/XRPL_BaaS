// Worker-specific XRPL singletons (XRPL pool, sequencer, signer).
//
// Queue definitions, job payload types, and enqueue helpers live in
// @railforge/jobs — shared with apps/api so the API can enqueue jobs
// without a boundary violation. This file only holds things that apply
// to the CONSUMER side (the worker process).
//
// Re-exports from @railforge/jobs are included so existing worker code
// that imports queue names / enqueue helpers from this file keeps working.

import { HsmSigner } from './xrpl/HsmSigner.ts';
import { XrplClientPool } from './xrpl/client.ts';
import { TxSequencer } from './xrpl/sequencer.ts';
import { DevSigner, type Signer } from './xrpl/signer.ts';

export {
  TX_SUBMIT_QUEUE,
  TX_CONFIRM_QUEUE,
  WEBHOOK_DELIVERY_QUEUE,
  ACCOUNT_SETUP_QUEUE,
  getJobsRedis,
  getTxSubmitQueue,
  getTxConfirmQueue,
  getWebhookDeliveryQueue,
  enqueueTxSubmit,
  enqueueWebhookDelivery,
  enqueueAccountSetup,
  disconnectJobs,
} from '@railforge/jobs';
export type {
  TxSubmitJobData,
  TxConfirmJobData,
  WebhookDeliveryJobData,
  AccountSetupJobData,
} from '@railforge/jobs';

// ── Worker-only singletons ──────────────────────────────────────────────────

let xrplPool: XrplClientPool | null = null;
let sequencer: TxSequencer | null = null;
let signer: Signer | null = null;

export async function getXrplPool(): Promise<XrplClientPool> {
  if (xrplPool) return xrplPool;
  xrplPool = new XrplClientPool();
  const network = process.env.XRPL_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  await xrplPool.initialize(network);
  return xrplPool;
}

export async function getSequencer(): Promise<TxSequencer> {
  if (sequencer) return sequencer;
  // TxSequencer needs a Redis client — reuse the jobs-package singleton
  // so we don't open a second connection.
  const { getJobsRedis } = await import('@railforge/jobs');
  sequencer = new TxSequencer(getJobsRedis(), await getXrplPool());
  return sequencer;
}

export function getSigner(): Signer {
  if (signer) return signer;
  // HSM Phase 2: pick signer based on HSM_PROVIDER env var.
  //   - 'aws_cloudhsm' → HsmSigner (prod, requires CloudHSM client daemon)
  //   - anything else   → DevSigner (dev/test; refuses NODE_ENV=production)
  if (process.env.HSM_PROVIDER === 'aws_cloudhsm') {
    signer = new HsmSigner({
      slotId: Number(process.env.HSM_SLOT ?? '0'),
      pin: `${process.env.HSM_CU_USERNAME ?? ''}:${process.env.HSM_CU_PASSWORD ?? ''}`,
      modulePath: process.env.HSM_MODULE_PATH ?? '/opt/cloudhsm/lib/libcloudhsm_pkcs11.so',
    });
  } else {
    signer = new DevSigner();
  }
  return signer;
}

// Tests and graceful shutdown use this.
export async function disconnectWorker(): Promise<void> {
  const { disconnectJobs } = await import('@railforge/jobs');
  await Promise.all([xrplPool?.shutdown(), disconnectJobs()]);
  xrplPool = null;
  sequencer = null;
  signer = null;
}
