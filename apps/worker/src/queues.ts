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
  //
  // HSM Phase 3 guard: on mainnet, DevSigner is NEVER acceptable. A prod
  // misconfig that silently falls back to DevSigner would sign real-money
  // txs with a software-held key. Fail fast at signer-selection time so
  // the worker refuses to start processing rather than producing one
  // unsafe signature before anyone notices. Also enforced as a dedicated
  // boot preflight (assertMainnetHsmInvariant) so the worker exits 1 on
  // startup rather than on first tx.
  const network = process.env.XRPL_NETWORK ?? 'testnet';
  const provider = process.env.HSM_PROVIDER;
  if (network === 'mainnet' && provider !== 'aws_cloudhsm') {
    throw new Error(
      'refusing to sign mainnet txs without HSM: set HSM_PROVIDER=aws_cloudhsm ' +
        '(XRPL_NETWORK=mainnet requires a hardware signer)',
    );
  }
  if (provider === 'aws_cloudhsm') {
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

/**
 * Boot-time preflight: refuse to start the worker if we're pointed at
 * mainnet without an HSM-backed signer. Exists separately from
 * getSigner() so the failure is surfaced at process start rather than
 * on the first tx enqueue. Throws — callers should let the error bubble
 * up and exit the process.
 */
export function assertMainnetHsmInvariant(): void {
  const network = process.env.XRPL_NETWORK ?? 'testnet';
  const provider = process.env.HSM_PROVIDER;
  if (network === 'mainnet' && provider !== 'aws_cloudhsm') {
    throw new Error(
      'mainnet boot blocked: XRPL_NETWORK=mainnet requires HSM_PROVIDER=aws_cloudhsm',
    );
  }
}

// Tests and graceful shutdown use this.
export async function disconnectWorker(): Promise<void> {
  const { disconnectJobs } = await import('@railforge/jobs');
  await Promise.all([xrplPool?.shutdown(), disconnectJobs()]);
  xrplPool = null;
  sequencer = null;
  signer = null;
}
