// x402 settlement verifier. SPRINT_10_PLAN.md §4.3 + §6.
//
// Given an `(intentId, txHash)` pair from the X-PAYMENT header, decide
// whether the on-ledger Payment satisfies the intent. Fail-closed: any
// missing / mismatching field returns a discrete failure reason instead
// of "no" — the route handler maps those onto a fresh 402 (or an error
// log for the dashboard).
//
// Why API-side, not worker-side: verification is on the request hot path.
// The latency budget is one rippled `tx` round-trip plus one atomic DB
// update; pushing that to the worker via BullMQ would add tens of
// milliseconds of overhead for no gain.
//
// Validation order matters — each step short-circuits on the first miss:
//
//   1. Intent exists in DB
//   2. Intent not already consumed
//   3. Intent not expired
//   4. rippled tx fetched + validated + tesSUCCESS
//   5. tx is a Payment
//   6. tx.Destination == intent.payeeAddress
//   7. tx.DestinationTag == intent.destinationTag
//   8. Asset matches:
//        - XRP: delivered_amount is a drops string >= intent.amount
//        - MPT: delivered_amount is { mpt_issuance_id, value };
//               id matches AND value >= intent.amount
//   9. Atomic consume via x402Intent.consumeIntent — fails closed if a
//      sibling request already claimed the same intent (HIGH-08 pattern).
//
// MPT semantics depend on the `fixMPTDeliveredAmount` amendment which is
// active on mainnet + testnet (see PLAN.md §7.4 amendment refresh). Pre-
// fix, MPT `delivered_amount` was reported as the IOU shape; we don't
// support that legacy shape here.

import { intentIdToDestinationTag } from '@railforge/xrpl-core';
import { logger } from '../logger.ts';
import { type ReadClient, getReadClient } from '../xrpl/readClient.ts';
import { type X402Intent, consumeIntent, findIntent } from './x402Intent.service.ts';

const log = logger.child({ component: 'x402-verify' });

// ── Public types ────────────────────────────────────────────────────────────

export type X402VerifyFailureReason =
  | 'not_found'
  | 'already_consumed'
  | 'expired'
  | 'tx_lookup_failed'
  | 'not_validated'
  | 'not_payment'
  | 'payee_mismatch'
  | 'tag_mismatch'
  | 'asset_mismatch'
  | 'amount_short';

export type X402VerifyResult =
  | { ok: true; intent: X402Intent; ledgerIndex: number | null }
  | { ok: false; reason: X402VerifyFailureReason };

// Test seam — the integration test will provide a real client, but the
// unit test suite injects a mock. The implementation uses getReadClient
// by default; passing a `client` overrides it.
export interface VerifyOptions {
  client?: ReadClient;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Shape of the rippled `tx` response we care about. xrpl.js types are too
 * loose for our needs (the `tx` command predates the v1/v2 split and the
 * MPT delivered_amount shape) so we narrow it ourselves at the boundary.
 */
interface TxResponse {
  validated?: boolean;
  ledger_index?: number;
  // v1 inline shape: top-level Account / Destination / etc.
  Account?: string;
  Destination?: string;
  TransactionType?: string;
  DestinationTag?: number;
  Amount?: unknown;
  // v2 shape: nested under tx_json.
  tx_json?: {
    Account?: string;
    Destination?: string;
    TransactionType?: string;
    DestinationTag?: number;
    Amount?: unknown;
    DeliverMax?: unknown;
  };
  meta?: {
    TransactionResult?: string;
    delivered_amount?: unknown;
  };
}

/**
 * Read a tx field that may be either at the top level (v1) or nested in
 * `tx_json` (v2). Returns the first non-undefined value.
 */
function txField<K extends keyof TxResponse>(tx: TxResponse, key: K): TxResponse[K];
function txField(tx: TxResponse, key: string): unknown {
  const top = (tx as Record<string, unknown>)[key];
  if (top !== undefined) return top;
  return (tx.tx_json as Record<string, unknown> | undefined)?.[key];
}

interface AssetCheckOk {
  ok: true;
}
interface AssetCheckFail {
  ok: false;
  reason: 'asset_mismatch' | 'amount_short';
}

/**
 * Decide whether the rippled `delivered_amount` field satisfies the
 * intent's (assetKind, assetKey, amount) tuple. Reads the AUTHORITATIVE
 * meta field — never Amount (which is the submitted, not delivered,
 * amount; partial payments would silently overpass an Amount check).
 */
function assetSatisfiesIntent(
  intent: X402Intent,
  deliveredAmount: unknown,
): AssetCheckOk | AssetCheckFail {
  if (intent.assetKind === 'xrp') {
    // XRP: drops string. Anything else (object, undefined, non-numeric)
    // is a mismatch — could be an MPT payment that landed at the right
    // destination by accident, or a v2 shape we mis-parsed.
    if (typeof deliveredAmount !== 'string' || !/^[0-9]+$/.test(deliveredAmount)) {
      return { ok: false, reason: 'asset_mismatch' };
    }
    if (BigInt(deliveredAmount) < BigInt(intent.amount)) {
      return { ok: false, reason: 'amount_short' };
    }
    return { ok: true };
  }

  // MPT: post-fixMPTDeliveredAmount shape is `{ mpt_issuance_id, value }`.
  if (
    typeof deliveredAmount !== 'object' ||
    deliveredAmount === null ||
    Array.isArray(deliveredAmount)
  ) {
    return { ok: false, reason: 'asset_mismatch' };
  }
  const o = deliveredAmount as { mpt_issuance_id?: unknown; value?: unknown };
  const idOnTx = typeof o.mpt_issuance_id === 'string' ? o.mpt_issuance_id.toUpperCase() : null;
  const valueStr = typeof o.value === 'string' ? o.value : null;
  if (!idOnTx || !valueStr) return { ok: false, reason: 'asset_mismatch' };
  // assetKey is upper-cased on the way in (parseX402Asset normalises).
  if (idOnTx !== intent.assetKey) return { ok: false, reason: 'asset_mismatch' };
  if (!/^[0-9]+$/.test(valueStr)) return { ok: false, reason: 'asset_mismatch' };
  if (BigInt(valueStr) < BigInt(intent.amount)) return { ok: false, reason: 'amount_short' };
  return { ok: true };
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Verify and atomically consume an x402 intent against an on-ledger tx.
 *
 * Returns `{ ok: true, intent, ledgerIndex }` on success — caller gates
 * the resource and may include the intent on the response. Returns
 * `{ ok: false, reason }` on any failure; reasons are stable identifiers
 * the route handler maps onto a re-quoted 402 + dashboard analytics.
 */
export async function verifyPayment(
  intentId: string,
  txHash: string,
  opts: VerifyOptions = {},
): Promise<X402VerifyResult> {
  // 1–3: intent lifecycle checks.
  const intent = await findIntent(intentId);
  if (!intent) return { ok: false, reason: 'not_found' };
  if (intent.consumedAt !== null) return { ok: false, reason: 'already_consumed' };
  if (intent.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  // 4: fetch tx from rippled. We swallow ALL errors here as `tx_lookup_failed`
  // because a rippled-side miss (unknown txid, server overload, network blip)
  // is indistinguishable to us — caller reissues 402 either way.
  const client = opts.client ?? (await getReadClient());
  let tx: TxResponse;
  try {
    const resp = await client.request({ command: 'tx', transaction: txHash });
    tx = (resp.result ?? resp) as TxResponse;
  } catch (err) {
    log.warn({ err, intentId, txHash }, 'x402 verify: tx lookup failed');
    return { ok: false, reason: 'tx_lookup_failed' };
  }

  // 5: validated + tesSUCCESS. Both required — a tx may have validated
  // with a `tec` result code, which means it's on-ledger but failed
  // execution; not a settlement.
  if (tx.validated !== true) return { ok: false, reason: 'not_validated' };
  if (tx.meta?.TransactionResult !== 'tesSUCCESS') {
    return { ok: false, reason: 'not_validated' };
  }

  // 6: must be a Payment. Other tx types (OfferCreate, EscrowFinish, etc.)
  // can move balances but aren't what the intent quotes.
  if (txField(tx, 'TransactionType') !== 'Payment') {
    return { ok: false, reason: 'not_payment' };
  }

  // 7: destination + tag match.
  if (txField(tx, 'Destination') !== intent.payeeAddress) {
    return { ok: false, reason: 'payee_mismatch' };
  }
  const txTag = txField(tx, 'DestinationTag');
  // Defense-in-depth: recompute the tag from the intent id (don't trust
  // the DB column alone — an attacker who flipped the column AND knew
  // the matching tx wouldn't get past xrpl-core's CRC).
  const expectedTag = intentIdToDestinationTag(intent.id);
  if (txTag !== intent.destinationTag || txTag !== expectedTag) {
    return { ok: false, reason: 'tag_mismatch' };
  }

  // 8: asset + amount via meta.delivered_amount.
  const deliveredAmount = tx.meta?.delivered_amount;
  const assetCheck = assetSatisfiesIntent(intent, deliveredAmount);
  if (!assetCheck.ok) return { ok: false, reason: assetCheck.reason };

  // 9: atomic claim. consumeIntent re-checks consumed+expiry in SQL, so
  // even if a sibling request got past step 2/3 above by interleaving,
  // exactly one of us wins.
  const claimed = await consumeIntent(intent.id, txHash);
  if (!claimed) return { ok: false, reason: 'already_consumed' };

  log.info(
    {
      intentId,
      txHash,
      assetKind: intent.assetKind,
      amount: intent.amount,
      ledgerIndex: tx.ledger_index ?? null,
    },
    'x402 payment verified',
  );

  return {
    ok: true,
    intent: { ...intent, consumedAt: new Date(), consumingTxHash: txHash },
    ledgerIndex: typeof tx.ledger_index === 'number' ? tx.ledger_index : null,
  };
}
