// Worker entry point. Spawns BullMQ workers for transaction submission,
// confirmation polling, webhook delivery, credential expiry alerts, and
// reserve reclamation. See PLAN.md §4.3 pipeline.
//
// Shared singletons (Redis connection, XRPL pool, sequencer, signer) live
// in ./queues.ts. Each job module exports a start*Worker function that
// wires its BullMQ worker to the shared Redis. On SIGTERM/SIGINT we close
// everything gracefully so in-flight jobs finish before the process exits.

import { Redis } from 'ioredis';
import { startCredentialExpiryWorker } from './jobs/credentialExpiry.ts';
import { startTxConfirmWorker } from './jobs/txConfirmer.ts';
import { startTxSubmitWorker } from './jobs/txSubmitter.ts';
import { startWebhookDeliveryWorker } from './jobs/webhookDelivery.ts';
import { logger } from './logger.ts';
import { disconnectWorker, getSigner } from './queues.ts';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const workerRedis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
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

logger.info(
  {
    queues: ['tx-submit', 'tx-confirm', 'webhook-delivery', 'credential-expiry'],
    redis: redisUrl,
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
  ]);
  await disconnectWorker();
  await workerRedis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
