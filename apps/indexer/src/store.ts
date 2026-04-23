// Persists indexer-derived state.
//
// Two buckets:
//
//   1. Redis high-water mark   → `railforge:indexer:hwm` (one integer).
//      Lets the indexer resume from the last validated ledger on restart.
//
//   2. Postgres                → processed_transactions (dedup gate) +
//      derived tables (offer_book, account_balances, amm_pools).
//
// Idempotency rule: every tx write hits processed_transactions FIRST via
// INSERT ... ON CONFLICT DO NOTHING. If the row already existed, we skip
// all downstream UPSERTs so replay after reconnect is a no-op. The ledger
// is the authoritative source — these tables are denormalized views we
// wipe and rebuild if they ever drift.
//
// Writes are guarded by initPg() / initStore() so unit tests that don't
// need persistence can inject fakes (or skip the whole thing).

import { and, db as dbDefault, eq, schema, sql } from '@railforge/db';
import { logger } from './logger.ts';
import type { TxEvent, XrplAmount } from './parser.ts';
import type { IndexedLedger } from './parser.ts';

const log = logger.child({ component: 'store' });

const HWM_KEY = 'railforge:indexer:hwm';

/**
 * Minimal Redis interface — just get/set a string.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

let store: KvStore | null = null;
// Database client — defaults to the shared @railforge/db connection but
// can be swapped for a fake in unit tests.
let db: typeof dbDefault = dbDefault;

export function initStore(kv: KvStore): void {
  store = kv;
}

/** Test seam: inject a fake db client. Production code never calls this. */
export function __setDbForTests(fake: typeof dbDefault): void {
  db = fake;
}

export async function persistLedger(ledger: IndexedLedger): Promise<void> {
  if (!store) {
    log.warn('store not initialized — skipping persist');
    return;
  }

  await store.set(HWM_KEY, String(ledger.ledgerIndex));
  log.debug(
    {
      ledgerIndex: ledger.ledgerIndex,
      txCount: ledger.txCount,
      closedAt: ledger.closedAt,
    },
    'ledger persisted',
  );
}

export async function getHighWaterMark(): Promise<number | null> {
  if (!store) return null;
  const raw = await store.get(HWM_KEY);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

// ── Per-tx persistence ─────────────────────────────────────────────────────

/**
 * Canonical asset key for the balances / pool tables.
 * XRP → 'XRP'. Issued currency → 'CUR:issuer'. MPT → the issuance ID.
 * Returns { kind, key } or null if the amount shape is unknown.
 */
export function amountAssetKey(amount: XrplAmount): {
  kind: 'xrp' | 'iou' | 'mpt';
  key: string;
} {
  if (typeof amount === 'string') return { kind: 'xrp', key: 'XRP' };
  if ('mpt_issuance_id' in amount) return { kind: 'mpt', key: amount.mpt_issuance_id };
  return { kind: 'iou', key: `${amount.currency}:${amount.issuer}` };
}

/**
 * Persist a single validated transaction event. Returns `true` when
 * this was the first time we saw the tx (and any side-table writes
 * ran); `false` when the tx was already processed (replay). The caller
 * uses this for observability but should not branch on it.
 */
export async function persistTransaction(event: TxEvent): Promise<boolean> {
  // Dedup gate. ON CONFLICT DO NOTHING — RETURNING gives us the written
  // rows, or empty if we raced with ourselves (replay after reconnect).
  const inserted = await db
    .insert(schema.processedTransactions)
    .values({
      txHash: event.txHash,
      ledgerIndex: event.ledgerIndex,
      txType: event.kind,
    })
    .onConflictDoNothing({ target: schema.processedTransactions.txHash })
    .returning({ txHash: schema.processedTransactions.txHash });

  if (inserted.length === 0) {
    log.debug({ txHash: event.txHash, kind: event.kind }, 'tx already processed — skip');
    return false;
  }

  // Failed txs burn a fee and land on-ledger, but they don't move any
  // state we care about mirroring. We still dedup-record them above so
  // subsequent replays stay idempotent.
  if (!event.success) {
    return true;
  }

  try {
    switch (event.kind) {
      case 'offer_create':
        await upsertOfferBook(event);
        break;
      case 'offer_cancel':
        await deleteOffer(event.account, event.offerSequence);
        break;
      // Payment / credential events are not mirrored to indexer-owned
      // tables — the API-side service tables already hold the canonical
      // state for managed accounts, and live rippled queries cover
      // external accounts. We still dedup-record them so replay is
      // a no-op.
      case 'payment':
      case 'credential_create':
      case 'credential_accept':
      case 'credential_delete':
      case 'domain_delete':
      case 'other':
        break;
      case 'domain_set':
        // Backfill the real on-ledger DomainID for the API-side domains
        // row created with a `pending-<uuid>` placeholder. Only fires for
        // creates (parser sets isCreate=true when it pulls the id from
        // meta.CreatedNode). Updates reuse an existing DomainID so no
        // backfill is needed.
        await backfillDomainId(event);
        break;
    }
  } catch (err) {
    // A downstream UPSERT failure must not leave an orphaned dedup row —
    // rollback the dedup insert so a future replay will retry.
    log.error({ err, txHash: event.txHash, kind: event.kind }, 'persist failed — rolling back');
    await db
      .delete(schema.processedTransactions)
      .where(eq(schema.processedTransactions.txHash, event.txHash));
    throw err;
  }
  return true;
}

// ── Offer book ─────────────────────────────────────────────────────────────

function canonicalPairKey(a: XrplAmount, b: XrplAmount): string {
  const ka = amountAssetKey(a).key;
  const kb = amountAssetKey(b).key;
  // Lexicographic sort so base↔counter queries hit the same index
  // regardless of order. `<key>|<key>` separator keeps the two sides
  // distinct (': ' appears inside IOU keys).
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

async function upsertOfferBook(event: {
  account: string;
  sequence: number;
  takerPays: XrplAmount;
  takerGets: XrplAmount;
  domainId?: string;
  ledgerIndex: number;
}): Promise<void> {
  const pairKey = canonicalPairKey(event.takerPays, event.takerGets);
  await db
    .insert(schema.offerBook)
    .values({
      account: event.account,
      sequence: event.sequence,
      takerPays: event.takerPays as unknown as object,
      takerGets: event.takerGets as unknown as object,
      pairKey,
      domainId: event.domainId ?? null,
      ledgerIndex: event.ledgerIndex,
    })
    .onConflictDoUpdate({
      target: [schema.offerBook.account, schema.offerBook.sequence],
      set: {
        takerPays: event.takerPays as unknown as object,
        takerGets: event.takerGets as unknown as object,
        pairKey,
        domainId: event.domainId ?? null,
        ledgerIndex: event.ledgerIndex,
        updatedAt: sql`now()`,
      },
    });
}

async function deleteOffer(account: string, offerSequence: number): Promise<void> {
  await db
    .delete(schema.offerBook)
    .where(
      and(eq(schema.offerBook.account, account), eq(schema.offerBook.sequence, offerSequence)),
    );
}

// ── Domain backfill ────────────────────────────────────────────────────────

/**
 * On a PermissionedDomainSet that CREATED a new ledger entry, flip the
 * API-side placeholder `pending-<uuid>` domain_id to the real on-ledger
 * DomainID. The placeholder is written by domain.service.createDomain at
 * request time so the API can return an id before the tx validates; the
 * indexer closes the loop once the entry materializes on-chain.
 *
 * Match strategy mirrors the MPT id backfill in apps/worker/src/jobs/
 * txConfirmer.ts — scope by owner_address and pick the newest pending row.
 * The API-side sequencer serializes per-owner so the most-recent pending
 * row is the one this event validates.
 */
async function backfillDomainId(event: {
  kind: 'domain_set';
  account: string;
  domainId?: string;
  isCreate?: boolean;
}): Promise<void> {
  if (!event.isCreate || !event.domainId) return;

  // Match on owner_address + pending-prefixed placeholder. Ordering by
  // created_at desc is load-bearing for the same reason as the MPT
  // backfill: an older orphaned pending row (from a failed attempt)
  // must not steal the id slot.
  const rows = await db
    .select({ id: schema.domains.id })
    .from(schema.domains)
    .where(
      and(
        eq(schema.domains.ownerAddress, event.account),
        sql`${schema.domains.domainId} LIKE 'pending-%'`,
      ),
    )
    .orderBy(sql`${schema.domains.createdAt} DESC`)
    .limit(1);
  const rowId = rows[0]?.id;
  if (!rowId) return;

  await db
    .update(schema.domains)
    .set({ domainId: event.domainId })
    .where(eq(schema.domains.id, rowId));
  log.info(
    { domainId: event.domainId, rowId, owner: event.account },
    'domain_id backfilled from ledger',
  );
}
