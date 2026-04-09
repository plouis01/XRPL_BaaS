// Worker-specific XRPL singletons (XRPL pool, sequencer, signer).
//
// Queue definitions, job payload types, and enqueue helpers live in
// @railforge/jobs — shared with apps/api so the API can enqueue jobs
// without a boundary violation. This file only holds things that apply
// to the CONSUMER side (the worker process).
//
// Re-exports from @railforge/jobs are included so existing worker code
// that imports queue names / enqueue helpers from this file keeps working.

import { XrplClientPool } from './xrpl/client.ts';
import { TxSequencer } from './xrpl/sequencer.ts';
import { DevSigner, type Signer } from './xrpl/signer.ts';

export {
  TX_SUBMIT_QUEUE,
  TX_CONFIRM_QUEUE,
  WEBHOOK_DELIVERY_QUEUE,
  getJobsRedis,
  getTxSubmitQueue,
  getTxConfirmQueue,
  enqueueTxSubmit,
  disconnectJobs,
} from '@railforge/jobs';
export type { TxSubmitJobData, TxConfirmJobData } from '@railforge/jobs';

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
  // Sprint 2: DevSigner only. Sprint 3+ switches to HsmSigner in production.
  // DevSigner's constructor refuses to start if NODE_ENV=production, so
  // this is safe to call unconditionally in dev/test.
  signer = new DevSigner();
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
