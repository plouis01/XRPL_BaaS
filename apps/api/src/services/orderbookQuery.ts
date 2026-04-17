// Indexer-backed orderbook reads.
//
// `/v1/dex/orderbook/:base/:counter` defaults to live `book_offers`
// against rippled — always authoritative. With `?source=indexer` the
// route reads the `offer_book` Postgres table maintained by the indexer
// (see apps/indexer/src/store.ts `upsertOfferBook`). That path is cheap
// (no rippled round-trip) but only as fresh as the indexer's
// high-water mark.
//
// Row shape is normalized back to look roughly like what rippled returns
// from `book_offers` so clients consuming either source get the same
// JSON shape — no special-casing per source in the frontend.

import { and, db, eq, schema } from '@railforge/db';
import type { ParsedAsset } from './assetQuery.ts';

export class OrderbookSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderbookSourceError';
  }
}

function assetKeyForIndexer(a: ParsedAsset): string {
  if (a.kind === 'xrp') return 'XRP';
  if (a.kind === 'mpt') return a.mptIssuanceId as string;
  return `${a.currency}:${a.issuer}`;
}

function canonicalPairKey(base: ParsedAsset, counter: ParsedAsset): string {
  const ka = assetKeyForIndexer(base);
  const kb = assetKeyForIndexer(counter);
  // Must match the sort in apps/indexer/src/store.ts `canonicalPairKey`.
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/**
 * Read the orderbook for (base, counter) from the indexer's offer_book
 * cache. Returns a shape roughly compatible with rippled's `book_offers`.
 */
export async function readOrderbookFromIndexer(
  base: ParsedAsset,
  counter: ParsedAsset,
  limit: number,
): Promise<{
  offers: unknown[];
  ledger_index: number | null;
  source: 'indexer';
}> {
  const pairKey = canonicalPairKey(base, counter);

  const rows = await db
    .select({
      account: schema.offerBook.account,
      sequence: schema.offerBook.sequence,
      takerPays: schema.offerBook.takerPays,
      takerGets: schema.offerBook.takerGets,
      domainId: schema.offerBook.domainId,
      ledgerIndex: schema.offerBook.ledgerIndex,
    })
    .from(schema.offerBook)
    .where(and(eq(schema.offerBook.pairKey, pairKey)))
    .limit(limit);

  // Normalize to rippled's book_offers shape (PascalCase, `Account`/`Sequence`).
  const offers = rows.map((r) => ({
    Account: r.account,
    Sequence: r.sequence,
    TakerPays: r.takerPays,
    TakerGets: r.takerGets,
    ...(r.domainId ? { DomainID: r.domainId } : {}),
  }));

  // The "ledger_index" for an indexer read isn't a single ledger — it's
  // the max ledger across the rows we returned, or null if empty. That's
  // the highest ledger at which any of these offers was confirmed.
  const ledgerIndex = rows.reduce<number | null>(
    (acc, r) =>
      r.ledgerIndex !== null && (acc === null || r.ledgerIndex > acc) ? r.ledgerIndex : acc,
    null,
  );

  return { offers, ledger_index: ledgerIndex, source: 'indexer' };
}
