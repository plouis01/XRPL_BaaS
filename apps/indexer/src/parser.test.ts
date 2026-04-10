// Unit tests for parser.ts — pure function, no mocks needed.
//
// Coverage:
//   1. Happy path: converts LedgerCloseEvent to IndexedLedger
//   2. XRPL epoch → ISO date conversion is correct
//   3. Missing ledgerIndex → null
//   4. Missing ledgerHash → null
//   5. txCount defaults to 0 when not provided

import { describe, expect, it } from 'vitest';
import { parseLedgerClose } from './parser.ts';

describe('parseLedgerClose', () => {
  it('converts a valid LedgerCloseEvent to an IndexedLedger', () => {
    const result = parseLedgerClose({
      ledgerIndex: 12345678,
      ledgerHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
      closeTime: 800000000, // XRPL epoch seconds
      txCount: 42,
    });
    expect(result).not.toBeNull();
    expect(result?.ledgerIndex).toBe(12345678);
    expect(result?.ledgerHash).toBe(
      'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
    );
    expect(result?.txCount).toBe(42);
  });

  it('converts XRPL epoch close_time to correct ISO-8601 date', () => {
    // XRPL epoch = Unix epoch + 946684800s
    // closeTime 0 in XRPL epoch = 2000-01-01T00:00:00.000Z
    const result = parseLedgerClose({
      ledgerIndex: 1,
      ledgerHash: 'AABB',
      closeTime: 0,
      txCount: 0,
    });
    expect(result?.closedAt).toBe('2000-01-01T00:00:00.000Z');
  });

  it('converts a known XRPL epoch timestamp correctly', () => {
    // closeTime 800000000 XRPL epoch = (800000000 + 946684800) * 1000 ms
    // = 1746684800000 ms = 2025-05-08T06:13:20.000Z
    const result = parseLedgerClose({
      ledgerIndex: 1,
      ledgerHash: 'AABB',
      closeTime: 800000000,
      txCount: 0,
    });
    expect(result?.closedAt).toBe('2025-05-08T06:13:20.000Z');
  });

  it('returns null when ledgerIndex is 0 (falsy)', () => {
    // ledgerIndex 0 is not a valid validated ledger
    const result = parseLedgerClose({
      ledgerIndex: 0,
      ledgerHash: 'AABB',
      closeTime: 100,
      txCount: 0,
    });
    expect(result).toBeNull();
  });

  it('returns null when ledgerHash is empty', () => {
    const result = parseLedgerClose({
      ledgerIndex: 1,
      ledgerHash: '',
      closeTime: 100,
      txCount: 0,
    });
    expect(result).toBeNull();
  });

  it('defaults txCount to the provided value (not silently zeroed)', () => {
    const result = parseLedgerClose({
      ledgerIndex: 1,
      ledgerHash: 'AABB',
      closeTime: 100,
      txCount: 99,
    });
    expect(result?.txCount).toBe(99);
  });
});
