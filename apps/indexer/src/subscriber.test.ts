// Unit tests for LedgerSubscriber.parseLedgerClose — the parsing logic
// that doesn't need a live WebSocket.
//
// The connect/reconnect lifecycle is tested via integration tests against
// a real testnet node (Sprint 4+). For Sprint 3 we only cover the
// deterministic parsing logic.

import { describe, expect, it } from 'vitest';
import { LedgerSubscriber } from './subscriber.ts';

// We need an instance to call parseLedgerClose (it's a public method).
// The handler is never called in these tests — we just need the parser.
const subscriber = new LedgerSubscriber('wss://unused', () => {});

describe('LedgerSubscriber.parseLedgerClose', () => {
  it('parses a well-formed rippled ledgerClosed message', () => {
    const result = subscriber.parseLedgerClose({
      ledger_index: 12345678,
      ledger_hash: 'ABCDEF',
      ledger_time: 800000000,
      txn_count: 42,
    });
    expect(result).toEqual({
      ledgerIndex: 12345678,
      ledgerHash: 'ABCDEF',
      closeTime: 800000000,
      txCount: 42,
    });
  });

  it('defaults txCount to 0 when txn_count is missing', () => {
    const result = subscriber.parseLedgerClose({
      ledger_index: 1,
      ledger_hash: 'AA',
      ledger_time: 100,
      // no txn_count
    });
    expect(result?.txCount).toBe(0);
  });

  it('returns null when ledger_index is missing', () => {
    const result = subscriber.parseLedgerClose({
      ledger_hash: 'AA',
      ledger_time: 100,
    });
    expect(result).toBeNull();
  });

  it('returns null when ledger_hash is missing', () => {
    const result = subscriber.parseLedgerClose({
      ledger_index: 1,
      ledger_time: 100,
    });
    expect(result).toBeNull();
  });

  it('returns null when ledger_time is missing', () => {
    const result = subscriber.parseLedgerClose({
      ledger_index: 1,
      ledger_hash: 'AA',
    });
    expect(result).toBeNull();
  });

  it('returns null for null input', () => {
    expect(subscriber.parseLedgerClose(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(subscriber.parseLedgerClose('not an object')).toBeNull();
  });
});
