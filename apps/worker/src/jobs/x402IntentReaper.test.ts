// Unit tests for x402IntentReaper.ts (Sprint 10 Day 8).
//
// Strategy: stub @railforge/db with an in-memory table + a `db.delete` chain
// that filters by a predicate function. Each test wires the predicate
// inputs (cutoff date + null check) so the SQL semantics are mirrored.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory table of intent rows. Each test rewires the contents via
// `setTable`. Rows use snake_case keys to match what the predicate
// helpers inspect.
interface FakeIntentRow {
  id: string;
  expires_at: Date;
  consumed_at: Date | null;
}

const tableState = {
  rows: [] as FakeIntentRow[],
};

function setTable(rows: FakeIntentRow[]): void {
  tableState.rows = rows;
}

// ── @railforge/db mock ─────────────────────────────────────────────────────

vi.mock('@railforge/db', () => {
  // The reaper's predicate is:
  //   and(lt(expires_at, cutoff), isNull(consumed_at))
  // Each helper closes over the comparison and returns a row predicate.
  // and() composes children. The DELETE chain runs the predicate and
  // returns the deleted ids.
  const lt = (col: string, val: unknown) => (row: Record<string, unknown>) => {
    const cell = row[col];
    if (cell instanceof Date && val instanceof Date) return cell.getTime() < val.getTime();
    return false;
  };
  const isNull = (col: string) => (row: Record<string, unknown>) => row[col] === null;
  const and =
    (...preds: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) =>
      preds.every((p) => (typeof p === 'function' ? p(row) : true));

  const deleteFn = (_table: { __name: 'x402Intents' }) => ({
    where: (pred: ((row: Record<string, unknown>) => boolean) | unknown) => ({
      returning: async (_proj: Record<string, unknown>) => {
        const filter =
          typeof pred === 'function'
            ? (pred as (r: Record<string, unknown>) => boolean)
            : () => false;
        const keep: FakeIntentRow[] = [];
        const deleted: Array<{ id: string }> = [];
        for (const row of tableState.rows) {
          if (filter(row as unknown as Record<string, unknown>)) {
            deleted.push({ id: row.id });
          } else {
            keep.push(row);
          }
        }
        tableState.rows = keep;
        return deleted;
      },
    }),
  });

  // sql tag — the reaper only uses it as a defensive `void sql` import.
  // Return a no-op marker.
  const sql =
    (..._args: unknown[]) =>
    () =>
      true;

  return {
    db: { delete: deleteFn },
    schema: {
      x402Intents: {
        __name: 'x402Intents' as const,
        id: 'id',
        expiresAt: 'expires_at',
        consumedAt: 'consumed_at',
      },
    },
    and,
    isNull,
    lt,
    sql,
  };
});

vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ── Tests ──────────────────────────────────────────────────────────────────

import { processX402IntentReaperSweep } from './x402IntentReaper.ts';

beforeEach(() => {
  tableState.rows = [];
});

const HOUR_MS = 60 * 60 * 1000;

describe('processX402IntentReaperSweep', () => {
  it('returns deletedCount=0 on an empty table', async () => {
    const result = await processX402IntentReaperSweep();
    expect(result.deletedCount).toBe(0);
  });

  it('deletes stale unconsumed rows past the default 1h grace window', async () => {
    const now = Date.now();
    setTable([
      // Expired 2h ago, unconsumed → eligible.
      {
        id: 'stale-1',
        expires_at: new Date(now - 2 * HOUR_MS),
        consumed_at: null,
      },
      // Expired 3h ago, unconsumed → eligible.
      {
        id: 'stale-2',
        expires_at: new Date(now - 3 * HOUR_MS),
        consumed_at: null,
      },
    ]);
    const result = await processX402IntentReaperSweep();
    expect(result.deletedCount).toBe(2);
    expect(tableState.rows.map((r) => r.id)).toEqual([]);
  });

  it('preserves consumed rows even when long expired (audit retention)', async () => {
    const now = Date.now();
    setTable([
      // Expired 10h ago but consumed → must stay.
      {
        id: 'consumed',
        expires_at: new Date(now - 10 * HOUR_MS),
        consumed_at: new Date(now - 9 * HOUR_MS),
      },
    ]);
    const result = await processX402IntentReaperSweep();
    expect(result.deletedCount).toBe(0);
    expect(tableState.rows.map((r) => r.id)).toEqual(['consumed']);
  });

  it('preserves rows whose expiry is in the grace window (< 1h past expires_at)', async () => {
    const now = Date.now();
    setTable([
      // Expired 30 min ago, unconsumed — still within the 1h grace.
      {
        id: 'recent',
        expires_at: new Date(now - 30 * 60 * 1000),
        consumed_at: null,
      },
    ]);
    const result = await processX402IntentReaperSweep();
    expect(result.deletedCount).toBe(0);
    expect(tableState.rows.map((r) => r.id)).toEqual(['recent']);
  });

  it('preserves rows that have not yet expired', async () => {
    const now = Date.now();
    setTable([
      // 5 min until expiry — must stay.
      {
        id: 'live',
        expires_at: new Date(now + 5 * 60 * 1000),
        consumed_at: null,
      },
    ]);
    const result = await processX402IntentReaperSweep();
    expect(result.deletedCount).toBe(0);
    expect(tableState.rows.map((r) => r.id)).toEqual(['live']);
  });

  it('honors a custom graceHours override (test seam)', async () => {
    const now = Date.now();
    setTable([
      // Expired 2h ago, unconsumed — would normally be eligible at 1h grace.
      {
        id: 'in-grace',
        expires_at: new Date(now - 2 * HOUR_MS),
        consumed_at: null,
      },
    ]);
    // Pass a 3h grace window — the row is still within it.
    const result = await processX402IntentReaperSweep(3);
    expect(result.deletedCount).toBe(0);
    expect(tableState.rows.map((r) => r.id)).toEqual(['in-grace']);
  });

  it('only deletes rows matching BOTH predicates (sanity: stale + unconsumed)', async () => {
    const now = Date.now();
    setTable([
      // Eligible
      { id: 'a', expires_at: new Date(now - 2 * HOUR_MS), consumed_at: null },
      // Same age but consumed
      {
        id: 'b',
        expires_at: new Date(now - 2 * HOUR_MS),
        consumed_at: new Date(now - 1 * HOUR_MS),
      },
      // Within grace
      {
        id: 'c',
        expires_at: new Date(now - 30 * 60 * 1000),
        consumed_at: null,
      },
    ]);
    const result = await processX402IntentReaperSweep();
    expect(result.deletedCount).toBe(1);
    expect(tableState.rows.map((r) => r.id).sort()).toEqual(['b', 'c']);
  });
});
