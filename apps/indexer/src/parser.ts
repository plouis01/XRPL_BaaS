// Parses raw XRPL ledger close events into normalized RailForge events.
//
// Sprint 3 scope: ledger-level events only (LedgerCloseEvent → IndexedLedger).
// Sprint 4+ adds transaction-level parsing (payment.confirmed, credential.issued,
// etc.) once the indexer subscribes to individual transactions.
//
// This module is the single source of truth for the internal event schema.
// Both the store (for DB writes) and the webhook fan-out (for client-facing
// payloads) should derive from these types.

import type { LedgerCloseEvent } from './subscriber.ts';

// XRPL epoch offset: seconds between Unix epoch (1970-01-01) and
// XRPL epoch (2000-01-01). Used to convert XRPL close_time to ISO dates.
const XRPL_EPOCH_OFFSET = 946684800;

/**
 * Normalized ledger close record ready for persistence.
 */
export interface IndexedLedger {
  ledgerIndex: number;
  ledgerHash: string;
  /** ISO-8601 UTC string derived from the XRPL epoch close_time. */
  closedAt: string;
  txCount: number;
}

/**
 * Convert a raw LedgerCloseEvent (from the subscriber) into an
 * IndexedLedger (for the store). Pure function — no I/O, no side effects.
 *
 * Returns null if the event is somehow invalid (defensive — the subscriber
 * already filters, but belt-and-braces).
 */
export function parseLedgerClose(event: LedgerCloseEvent): IndexedLedger | null {
  if (!event.ledgerIndex || !event.ledgerHash) return null;

  // Convert XRPL epoch seconds → Unix epoch → ISO string.
  const unixMs = (event.closeTime + XRPL_EPOCH_OFFSET) * 1000;
  const closedAt = new Date(unixMs).toISOString();

  return {
    ledgerIndex: event.ledgerIndex,
    ledgerHash: event.ledgerHash,
    closedAt,
    txCount: event.txCount,
  };
}
