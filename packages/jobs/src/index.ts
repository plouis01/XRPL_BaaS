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
//
// Sprint 3 note: BullMQ v5+ rejects colons in queue names (it uses `:`
// internally as the Redis key separator). The original `railforge:tx-*`
// names worked under v4 but throw "Queue name cannot contain :" under
// v5. Renamed to use `-` as the separator. Pre-Sprint-3 deploys had no
// in-flight jobs (no production yet), so this isn't a breaking change
// in practice — just a name update.

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

// ── Queue names ─────────────────────────────────────────────────────────────

export const TX_SUBMIT_QUEUE = 'railforge-tx-submit';
export const TX_CONFIRM_QUEUE = 'railforge-tx-confirm';
export const WEBHOOK_DELIVERY_QUEUE = 'railforge-webhook-delivery';
export const ACCOUNT_SETUP_QUEUE = 'railforge-account-setup';

/**
 * Webhook event types fired by the txConfirmer (apps/worker) on a tx row's
 * terminal transition. REVIEW.md MED-14: this MUST stay the single source
 * of truth — both the producer (txConfirmer.fanOutWebhooks) and the
 * indexer's skip gate (webhookFanout.ts TX_CONFIRMER_HANDLED) import it.
 * Before extracting this const, the two lived as an independently-typed
 * union + a literal Set duplicate. Adding a new terminal event type meant
 * editing both — a missed edit silently double-fired or silently dropped.
 *
 * Rule: whenever the txConfirmer gains a new `transaction.*` terminal
 * event, add it here. TypeScript + the indexer's Set lookup pick it up
 * automatically and the drift is impossible to reintroduce.
 */
export const TX_CONFIRMER_EVENT_TYPES = ['transaction.validated', 'transaction.failed'] as const;
export type TxConfirmerEventType = (typeof TX_CONFIRMER_EVENT_TYPES)[number];

/**
 * Agent-outcome events fired from txConfirmer's `applyAgentGrantOutcome`
 * hook (VISION.md agent launcher). Same fan-out site as the tx events
 * above — kept in a sibling const so the indexer's TX_CONFIRMER_HANDLED
 * skip-gate doesn't accidentally include events the indexer would never
 * derive from raw ledger txs anyway. Adding a new agent.* terminal event
 * means: append here, register in WEBHOOK_EVENT_TYPES (schemas.ts), and
 * emit from txConfirmer.
 */
export const AGENT_OUTCOME_EVENT_TYPES = [
  'agent.activated',
  'agent.failed',
  'agent.revoked',
] as const;
export type AgentOutcomeEventType = (typeof AGENT_OUTCOME_EVENT_TYPES)[number];

/** Union of all event types the txConfirmer fan-out can emit. */
export type WebhookFanoutEventType = TxConfirmerEventType | AgentOutcomeEventType;

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

/**
 * Job payload for webhook delivery.
 *
 * The payload itself lives in `webhook_deliveries.payload` so the worker
 * can fetch it by id without having a giant JSON blob serialized into
 * BullMQ's Redis-backed job store. Same reason `transactions.requestBody`
 * is in Postgres rather than the queue.
 *
 * The endpointId is included so the worker can fetch the URL + secret in
 * a single SELECT (avoiding a join through webhook_deliveries on retry).
 */
export interface WebhookDeliveryJobData {
  /** webhook_deliveries.id — the row the worker updates in place. */
  deliveryId: string;
  /** webhook_endpoints.id — the destination subscription. */
  endpointId: string;
}

/**
 * HSM Phase 2: when HSM_PROVIDER=aws_cloudhsm, the API can't generate a
 * keypair itself (the key must never leave the HSM). Instead it inserts
 * a placeholder accounts row and enqueues this job. The worker generates
 * the keypair in the HSM, updates the row with the real address + label,
 * and enqueues the funding tx.
 */
export interface AccountSetupJobData {
  /** accounts.id — the placeholder row the worker will update. */
  accountId: string;
  /** clients.id — needed for the transactions row + spend policy. */
  clientId: string;
  /** Treasury XRPL address for the funding Payment. */
  treasuryAddress: string;
  /** Funding amount in drops. */
  fundingAmountDrops: string;
  /** Optional label for the account. */
  label?: string;
  /** Custody mode. */
  custodyMode: string;
  /**
   * REVIEW.md HIGH-04: the request's Idempotency-Key. The worker persists
   * it on the funding `transactions` row so DB-layer UNIQUE catches
   * duplicate HSM account setups if this job is retried.
   */
  idempotencyKey?: string;
}

// ── Redis connection singleton ─────────────────────────────────────────────
//
// IMPORTANT: this connection is for PRODUCERS ONLY (BullMQ `Queue` instances
// + the worker-side TxSequencer). Consumer-side `Worker` instances open
// their own connection in apps/worker/src/index.ts (`workerRedis`) without
// `commandTimeout`, because BullMQ's BLPOP/BRPOPLPUSH calls legitimately
// block for minutes and a command timeout would cancel them mid-poll.
//
// Why fast-fail matters here: the API process calls `enqueueTxSubmit` etc.
// inside the request hot path. If the Upstash TCP connection wedges
// (NAT/middlebox dropped FIN/RST, Upstash node restart, etc.), `queue.add()`
// blocks forever waiting for a reply that will never come — the request
// never returns and the dashboard sees an infinite loading spinner. A 5s
// commandTimeout converts that into a clean error the route handler can
// surface; the orphan reconciler then sweeps any tx row whose enqueue
// failed (10 min grace).
//
// Note: `Queue.add` is non-blocking (LPUSH + ZADD), so a 5s ceiling never
// trips during healthy operation — it only catches the wedge case. Same
// for the TxSequencer (SET NX EX + a small Lua block).

let redisConnection: Redis | null = null;

export function getJobsRedis(): Redis {
  if (redisConnection) return redisConnection;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  redisConnection = new Redis(url, {
    // BullMQ requires `maxRetriesPerRequest: null` on every connection it
    // touches (Queue, Worker, QueueEvents) — the default retry behavior
    // collides with BullMQ's own scheduling. Independent of commandTimeout.
    maxRetriesPerRequest: null,
    // Upstash free-tier quirk: post-connect INFO probe sometimes hangs.
    // Skipping it removes a needless round-trip on every reconnect anyway.
    enableReadyCheck: false,
    // Load-bearing fix: half-open TCP → command hangs forever → request
    // hangs forever. 5s is generous for LPUSH/ZADD/EVAL on Upstash but
    // tight enough that the API recovers in seconds, not minutes.
    commandTimeout: 5000,
    // Fail synchronously when the connection is down rather than queueing
    // commands until reconnect. The route handler's try/catch path is
    // already wired for this (see apps/api/src/services/*.ts — every
    // enqueue call is logged-and-tolerated, with the orphan reconciler
    // as the safety net).
    enableOfflineQueue: false,
    // TCP keepalive every 30s so a dead connection surfaces as a real
    // error within ~1 min instead of silently hanging.
    keepAlive: 30000,
    // Widen reconnect triggers to the network-level disconnect patterns
    // we've actually seen in prod (in addition to ioredis's defaults).
    reconnectOnError(err: Error) {
      const msg = err.message ?? '';
      return /READONLY|CLUSTERDOWN|EPIPE|ECONNRESET|ETIMEDOUT|broken pipe/i.test(msg);
    },
    // Cap reconnect backoff at 2s so we don't stay disconnected for
    // minutes after a transient blip.
    retryStrategy(times) {
      if (times > 10) return null;
      return Math.min(times * 500, 2000);
    },
  });
  // Without an 'error' listener, ioredis emits 'unhandled error' and Node
  // crashes the process on a transient disconnect. We log and let the
  // built-in reconnect loop do its thing.
  redisConnection.on('error', (err: Error) => {
    // eslint-disable-next-line no-console — this package has no logger dep
    console.warn(
      JSON.stringify({
        level: 'warn',
        component: 'jobs-redis',
        msg: 'redis connection error',
        err: err.message ?? String(err),
      }),
    );
  });
  return redisConnection;
}

// ── Producer (queue) singletons ─────────────────────────────────────────────

let txSubmitQueue: Queue<TxSubmitJobData> | null = null;
let txConfirmQueue: Queue<TxConfirmJobData> | null = null;
let webhookDeliveryQueue: Queue<WebhookDeliveryJobData> | null = null;

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

export function getWebhookDeliveryQueue(): Queue<WebhookDeliveryJobData> {
  if (webhookDeliveryQueue) return webhookDeliveryQueue;
  // Per PLAN.md §4.4: 5 attempts at 5s, 10s, 20s, 40s, 80s. BullMQ's
  // exponential backoff doubles `delay` for each attempt — starting at
  // 5000ms gives the documented schedule (5s, 10s, 20s, 40s, 80s).
  // Total budget: ~155s before a delivery is marked permanently failed.
  webhookDeliveryQueue = new Queue<WebhookDeliveryJobData>(WEBHOOK_DELIVERY_QUEUE, {
    connection: getJobsRedis(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
  return webhookDeliveryQueue;
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

/**
 * Enqueue a webhook delivery for the worker to sign and POST.
 *
 * Caller MUST have already INSERTed the corresponding webhook_deliveries
 * row (so the worker can fetch the payload by id). The caller is usually
 * the txConfirmer fan-out path that runs after a tx validates on-ledger.
 */
export async function enqueueWebhookDelivery(data: WebhookDeliveryJobData): Promise<void> {
  const queue = getWebhookDeliveryQueue();
  await queue.add('deliver', data);
}

let accountSetupQueue: Queue<AccountSetupJobData> | null = null;

function getAccountSetupQueue(): Queue<AccountSetupJobData> {
  if (accountSetupQueue) return accountSetupQueue;
  accountSetupQueue = new Queue<AccountSetupJobData>(ACCOUNT_SETUP_QUEUE, {
    connection: getJobsRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
  return accountSetupQueue;
}

export async function enqueueAccountSetup(data: AccountSetupJobData): Promise<void> {
  const queue = getAccountSetupQueue();
  await queue.add('setup', data);
}

// ── Teardown ────────────────────────────────────────────────────────────────

export async function disconnectJobs(): Promise<void> {
  await Promise.all([
    txSubmitQueue?.close(),
    txConfirmQueue?.close(),
    webhookDeliveryQueue?.close(),
    accountSetupQueue?.close(),
  ]);
  txSubmitQueue = null;
  txConfirmQueue = null;
  webhookDeliveryQueue = null;
  accountSetupQueue = null;
  await redisConnection?.quit();
  redisConnection = null;
}
