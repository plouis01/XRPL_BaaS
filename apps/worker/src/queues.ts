// Shared BullMQ queue + XRPL singleton wiring for the worker process.
//
// Consumers (the jobs in src/jobs/*.ts AND the API, which enqueues jobs
// from the request path via @railforge/worker) import from here rather
// than instantiating their own connections. One Redis connection per
// worker process, one XRPL pool, one signer, one sequencer.
//
// The queue NAMES are part of the public contract between api and worker —
// renaming them breaks in-flight jobs on production rolling deploys. Add a
// new queue; never rename an existing one.

import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { XrplClientPool } from "./xrpl/client.ts";
import { TxSequencer } from "./xrpl/sequencer.ts";
import { DevSigner, type Signer } from "./xrpl/signer.ts";

// ── Queue names ─────────────────────────────────────────────────────────────
export const TX_SUBMIT_QUEUE = "railforge:tx-submit";
export const TX_CONFIRM_QUEUE = "railforge:tx-confirm";
export const WEBHOOK_DELIVERY_QUEUE = "railforge:webhook-delivery";

// ── Shared singletons ───────────────────────────────────────────────────────

let redisConnection: Redis | null = null;
let txSubmitQueue: Queue<TxSubmitJobData> | null = null;
let txConfirmQueue: Queue<TxConfirmJobData> | null = null;
let xrplPool: XrplClientPool | null = null;
let sequencer: TxSequencer | null = null;
let signer: Signer | null = null;

function getRedis(): Redis {
  if (redisConnection) return redisConnection;
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  redisConnection = new Redis(url, {
    // BullMQ requires this — blocking commands are its core scheduling
    // mechanism and get confused by the default retry behavior.
    maxRetriesPerRequest: null,
  });
  return redisConnection;
}

export function getTxSubmitQueue(): Queue<TxSubmitJobData> {
  if (txSubmitQueue) return txSubmitQueue;
  txSubmitQueue = new Queue<TxSubmitJobData>(TX_SUBMIT_QUEUE, {
    connection: getRedis(),
    defaultJobOptions: {
      // Retry transient failures; don't retry terminal failures
      // (the worker code decides via throw vs return).
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
  return txSubmitQueue;
}

export function getTxConfirmQueue(): Queue<TxConfirmJobData> {
  if (txConfirmQueue) return txConfirmQueue;
  txConfirmQueue = new Queue<TxConfirmJobData>(TX_CONFIRM_QUEUE, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 20, // polling — many quick retries
      backoff: { type: "fixed", delay: 4000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
  return txConfirmQueue;
}

export async function getXrplPool(): Promise<XrplClientPool> {
  if (xrplPool) return xrplPool;
  xrplPool = new XrplClientPool();
  const network =
    process.env.XRPL_NETWORK === "mainnet" ? "mainnet" : "testnet";
  await xrplPool.initialize(network);
  return xrplPool;
}

export async function getSequencer(): Promise<TxSequencer> {
  if (sequencer) return sequencer;
  sequencer = new TxSequencer(getRedis(), await getXrplPool());
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

// Tests and graceful shutdown use this to close all connections.
export async function disconnectWorker(): Promise<void> {
  await Promise.all([
    txSubmitQueue?.close(),
    txConfirmQueue?.close(),
    xrplPool?.shutdown(),
    redisConnection?.quit(),
  ]);
  txSubmitQueue = null;
  txConfirmQueue = null;
  xrplPool = null;
  sequencer = null;
  signer = null;
  redisConnection = null;
}

// ── Job payload shapes ──────────────────────────────────────────────────────
// These are the contracts between API (producer) and worker (consumer).
// Changes here need coordinated deploys; add fields, never remove them.

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
