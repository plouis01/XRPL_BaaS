import { resolveRedisFamily } from '@railforge/jobs';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { startAccountSetupWorker } from './jobs/accountSetup.ts';
import { CREDENTIAL_EXPIRY_QUEUE, startCredentialExpiryWorker } from './jobs/credentialExpiry.ts';
import { ORPHAN_RECONCILER_QUEUE, startOrphanReconcilerWorker } from './jobs/orphanReconciler.ts';
import { startTxConfirmWorker } from './jobs/txConfirmer.ts';
import { startTxSubmitWorker } from './jobs/txSubmitter.ts';
import { startWebhookDeliveryWorker } from './jobs/webhookDelivery.ts';
import { X402_INTENT_REAPER_QUEUE, startX402IntentReaperWorker } from './jobs/x402IntentReaper.ts';
import { logger } from './logger.ts';
import { assertMainnetHsmInvariant, disconnectWorker, getSigner } from './queues.ts';

// HSM Phase 3 preflight: mainnet without HSM is a non-starter. Surface the
// misconfig at boot rather than on the first tx.
assertMainnetHsmInvariant();

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const workerRedis = new Redis(redisUrl, {
  // family: 6 when REDIS_URL points at a Fly internal hostname (AAAA-only).
  // See resolveRedisFamily docstring for the full rationale.
  family: resolveRedisFamily(redisUrl),
  // BullMQ requires `maxRetriesPerRequest: null` — its blocking commands
  // would otherwise be canceled mid-poll. `enableReadyCheck: false` avoids
  // the post-connect INFO probe, which Upstash's free tier sometimes fails
  // and which adds a needless extra round-trip on every reconnect.
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Treasury wallet loading (Sprint 3).
//
// The treasury is a pre-funded XRPL account that pays the ~10 XRP base
// reserve (plus headroom) for every new account created via the API.
// This replaces the direct testnet-faucet call in account.service and
// routes funding through the same txSubmitter pipeline every other tx
// uses — meaning account creation exercises the prod sign+submit path
// from day one. Mirrors the eventual XLS-68 mainnet flow.
//
// We load the treasury seed here (not in queues.ts) because loading
// affects only the worker process. The API process never holds the
// treasury key — it only enqueues Payment jobs with the treasury
// address as the sourceAddress, and the worker's signer picks it up.
//
// Env var contract:
//   TREASURY_SEED    — xrpl.js seed string; required to enable treasury funding
//   TREASURY_ADDRESS — expected derived address; optional but loudly verified
//
// If TREASURY_SEED is unset, account creation will fail at enqueue time
// because no signer key exists for the configured source address. That
// failure is louder and earlier than silently falling back to the faucet,
// which is what we want.
//
// SECURITY: the seed lives in process memory for the lifetime of the
// worker. It is NEVER persisted, logged, or passed to any other function
// than signer.loadKey (which strips it before going into xrpl.js Wallet).
// The logger redact list covers master_key_ref / seed / wallet already.
const treasurySeed = process.env.TREASURY_SEED;
const treasuryAddress = process.env.TREASURY_ADDRESS;
if (treasurySeed) {
  if (!treasuryAddress) {
    // We require both because loading a seed without knowing the intended
    // address means we can't verify the seed decodes to the account the
    // operator thinks it does. Silent mismatch would route funding
    // payments from the wrong account.
    throw new Error('TREASURY_SEED is set but TREASURY_ADDRESS is not — refusing to start');
  }
  try {
    await getSigner().loadKey(treasuryAddress, treasurySeed);
    logger.info({ treasuryAddress }, 'treasury wallet loaded into signer');
  } catch (err) {
    // loadKey throws SignerError('no_key') on address mismatch — see
    // DevSigner.loadKey. Re-throw without the original message (it's
    // already sanitized) so startup fails loudly.
    logger.error({ err }, 'treasury wallet load failed');
    throw new Error('treasury wallet load failed — check TREASURY_SEED/TREASURY_ADDRESS');
  }
} else {
  // Starting without a treasury is allowed (for the non-custodial path
  // or for test environments that don't create accounts via the API),
  // but we log it so operators don't wonder why createAccount is 503ing.
  logger.warn('TREASURY_SEED not set — account creation via the API will fail');
}

const txSubmitWorker = startTxSubmitWorker(workerRedis);
const txConfirmWorker = startTxConfirmWorker(workerRedis);
const webhookDeliveryWorker = startWebhookDeliveryWorker(workerRedis);
const credentialExpiryWorker = startCredentialExpiryWorker(workerRedis);
const orphanReconcilerWorker = startOrphanReconcilerWorker(workerRedis);
const accountSetupWorker = startAccountSetupWorker(workerRedis);
const x402IntentReaperWorker = startX402IntentReaperWorker(workerRedis);

// Orphan reconciler repeat schedule (PLAN.md §9.2 G-1).
//
// The reconciler sweeps stale `transactions` rows whose enqueue never
// happened (Redis outage at create-time). The actual sweep logic lives
// in jobs/orphanReconciler.ts; here we register a BullMQ repeat job
// every 5 minutes so the worker keeps draining orphans without anyone
// having to manually push.
//
// Using a deterministic jobId on the repeat keeps re-registers
// idempotent across worker restarts — BullMQ will dedupe by id.
const orphanReconcilerScheduleQueue = new Queue(ORPHAN_RECONCILER_QUEUE, {
  connection: workerRedis,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});
await orphanReconcilerScheduleQueue.add(
  'sweep',
  {},
  {
    repeat: { every: 5 * 60 * 1000 },
    jobId: 'orphan-reconciler-sweep',
  },
);

// Credential expiry repeat schedule.
//
// The sweep runs every 6 hours (per credentialExpiry.ts header), checks
// for credentials expiring within the next 7 days, and fires
// 'credential.expiring' webhook alerts. The worker already existed but
// no repeat registration was ever added — jobs never got pushed.
const credentialExpiryScheduleQueue = new Queue(CREDENTIAL_EXPIRY_QUEUE, {
  connection: workerRedis,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});
await credentialExpiryScheduleQueue.add(
  'sweep',
  {},
  {
    repeat: { every: 6 * 60 * 60 * 1000 },
    jobId: 'credential-expiry-sweep',
  },
);

// x402 intent reaper repeat schedule (SPRINT_10_PLAN §8). Runs every
// 5 minutes; deletes stale unconsumed x402_intents rows past a 1h
// grace window. See jobs/x402IntentReaper.ts for the rationale on
// preserving consumed rows.
const x402IntentReaperScheduleQueue = new Queue(X402_INTENT_REAPER_QUEUE, {
  connection: workerRedis,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});
await x402IntentReaperScheduleQueue.add(
  'sweep',
  {},
  {
    repeat: { every: 5 * 60 * 1000 },
    jobId: 'x402-intent-reaper-sweep',
  },
);

// REVIEW.md LOW-09: log only the Redis host, never the full URL. A
// `rediss://default:<token>@host:port` (Upstash) landed here verbatim
// would leak the token into every startup log line. `new URL(...).host`
// keeps the identifying bit (which Redis, which port) without credentials.
let redisHost: string;
try {
  redisHost = new URL(redisUrl).host;
} catch {
  redisHost = '<unparseable>';
}

logger.info(
  {
    queues: [
      'tx-submit',
      'tx-confirm',
      'webhook-delivery',
      'credential-expiry',
      'orphan-reconciler',
      'account-setup',
      'x402-intent-reaper',
    ],
    redisHost,
    network: process.env.XRPL_NETWORK ?? 'testnet',
    treasuryLoaded: !!treasurySeed,
  },
  'railforge-worker started',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'railforge-worker shutting down');
  await Promise.all([
    txSubmitWorker.close(),
    txConfirmWorker.close(),
    webhookDeliveryWorker.close(),
    credentialExpiryWorker.close(),
    orphanReconcilerWorker.close(),
    accountSetupWorker.close(),
    x402IntentReaperWorker.close(),
    orphanReconcilerScheduleQueue.close(),
    credentialExpiryScheduleQueue.close(),
    x402IntentReaperScheduleQueue.close(),
  ]);
  await disconnectWorker();
  await workerRedis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Process-level diagnostics. Same shape as apps/api/src/index.ts — we
// intentionally do NOT swallow uncaughtException. Letting the process
// crash is the right recovery: fly.toml has `[[restart]] policy='always'`,
// so a fresh Bun is back in <1 s and BullMQ resumes the in-flight job from
// Redis. Tolerating throws keeps the broken postgres pool alive and causes
// every subsequent query to hang on dead connections (learned the hard way
// May 8 2026 — see git log).
process.on('uncaughtException', (err: Error) => {
  logger.error(
    { err: err?.message ?? String(err), stack: err?.stack },
    'uncaughtException — process will exit',
  );
  throw err;
});
process.on('unhandledRejection', (reason) => {
  logger.error(
    { reason: reason instanceof Error ? reason.message : String(reason) },
    'unhandledRejection',
  );
});
