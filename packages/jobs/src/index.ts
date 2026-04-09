// Shared BullMQ queue definitions and job payload types.
//
// Both apps/api (producer) and apps/worker (consumer) import from here.
// This package is the SINGLE source of truth for:
//   - Queue names (contract between producer and consumer)
//   - Job payload shapes (contract between producer and consumer)
//   - Enqueue helpers (used by services in apps/api)
//
// The worker's job IMPLEMENTATIONS still live in apps/worker — this
// package only defines the contract, not the processing logic.
//
// Queue names are part of the public contract. Renaming them breaks
// in-flight jobs on production rolling deploys. Add a new queue;
// never rename an existing one.

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

// ── Queue names ─────────────────────────────────────────────────────────────

export const TX_SUBMIT_QUEUE = 'railforge:tx-submit';
export const TX_CONFIRM_QUEUE = 'railforge:tx-confirm';
export const WEBHOOK_DELIVERY_QUEUE = 'railforge:webhook-delivery';

// ── Job payload shapes ──────────────────────────────────────────────────────

export interface TxSubmitJobData {
  /** transactions.id — the DB row the worker will update in place. */
  txId: string;
  /** The XRPL account that will sign. Signer.hasKey(sourceAddress) must be true. */
  sourceAddress: string;
  /**
   * Fully-built, unsigned tx from a builder in @railforge/xrpl-core/transactions.
   * Sequence, Fee, and LastLedgerSequence will be filled by the worker.
   */
  // biome-ignore lint/suspicious/noExplicitAny: xrpl Transaction union is awkward to serialize
  txJson: any;
}

export interface TxConfirmJobData {
  /** transactions.id — polling target. */
  txId: string;
  /** Tx hash returned by the initial submit. */
  txHash: string;
  /** LastLedgerSequence on the submitted tx — marks the expiry horizon. */
  lastLedger: number;
}

// ── Redis connection singleton ─────────────────────────────────────────────

let redisConnection: Redis | null = null;

export function getJobsRedis(): Redis {
  if (redisConnection) return redisConnection;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  redisConnection = new Redis(url, {
    // BullMQ requires this — blocking commands are its core scheduling
    // mechanism and get confused by the default retry behavior.
    maxRetriesPerRequest: null,
  });
  return redisConnection;
}

// ── Producer (queue) singletons ─────────────────────────────────────────────

let txSubmitQueue: Queue<TxSubmitJobData> | null = null;
let txConfirmQueue: Queue<TxConfirmJobData> | null = null;

export function getTxSubmitQueue(): Queue<TxSubmitJobData> {
  if (txSubmitQueue) return txSubmitQueue;
  txSubmitQueue = new Queue<TxSubmitJobData>(TX_SUBMIT_QUEUE, {
    connection: getJobsRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
  return txSubmitQueue;
}

export function getTxConfirmQueue(): Queue<TxConfirmJobData> {
  if (txConfirmQueue) return txConfirmQueue;
  txConfirmQueue = new Queue<TxConfirmJobData>(TX_CONFIRM_QUEUE, {
    connection: getJobsRedis(),
    defaultJobOptions: {
      attempts: 20, // polling — many quick retries
      backoff: { type: 'fixed', delay: 4000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
  return txConfirmQueue;
}

// ── High-level enqueue helpers (for service code in apps/api) ──────────────

/**
 * Enqueue a transaction for the worker to sign and submit.
 *
 * This is the ONLY sanctioned way for the API to initiate a tx. Services
 * that write to the `transactions` table must enqueue a corresponding job
 * OR the row will sit in 'queued' state forever.
 */
export async function enqueueTxSubmit(data: TxSubmitJobData): Promise<void> {
  const queue = getTxSubmitQueue();
  await queue.add('submit', data);
}

// ── Teardown ────────────────────────────────────────────────────────────────

export async function disconnectJobs(): Promise<void> {
  await Promise.all([txSubmitQueue?.close(), txConfirmQueue?.close()]);
  txSubmitQueue = null;
  txConfirmQueue = null;
  await redisConnection?.quit();
  redisConnection = null;
}
