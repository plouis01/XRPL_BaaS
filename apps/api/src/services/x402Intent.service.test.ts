// Unit tests for x402Intent.service.ts. SPRINT_10_PLAN.md §4.2.
//
// Strategy: mock @railforge/db with a stateful in-memory table. Lets us
// exercise:
//   - createIntent: a freshly-inserted row round-trips through findIntent
//   - consumeIntent: only the first call wins; subsequent calls return false
//   - route lookup: filters by (clientId, path, isActive) — soft-deleted
//     rows must not match
//   - asset validation: parseX402Asset reused from xrpl-core rejects bad
//     references at the service boundary

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Stateful tables. Each test resets via beforeEach.

interface IntentRow {
  id: string;
  client_id: string | null;
  resource_path: string;
  payee_address: string;
  asset_kind: string;
  asset_key: string | null;
  amount: string;
  destination_tag: number;
  expires_at: Date;
  consumed_at: Date | null;
  consuming_tx_hash: string | null;
  created_at: Date;
}

interface RouteRow {
  id: string;
  client_id: string;
  path_pattern: string;
  payee_address: string;
  asset_kind: string;
  asset_key: string | null;
  price_amount: string;
  is_active: boolean;
  created_at: Date;
}

const tables = {
  x402Intents: [] as IntentRow[],
  x402Routes: [] as RouteRow[],
};

let lastWhereFilter: ((row: Record<string, unknown>) => boolean) | null = null;
let nextUniqueViolation = false;

// camelCase ↔ snake_case at the row boundary. The service writes
// camelCase via Drizzle column refs; the in-memory rows here mirror the
// SQL column names so a `eq(schema.x402Intents.consumedAt, null)` style
// predicate can match `row.consumed_at`.
function toCamelCase(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

function snakeKey(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

vi.mock('@railforge/db', () => {
  type Row = Record<string, unknown>;

  const insert = (table: { __name: 'x402Intents' | 'x402Routes' }) => ({
    values: (vals: Row) => ({
      returning: async (): Promise<Row[]> => {
        if (nextUniqueViolation) {
          nextUniqueViolation = false;
          const err = new Error('unique violation') as Error & {
            code?: string;
          };
          err.code = '23505';
          throw err;
        }
        // Build a row using snake_case keys (mirrors the DB).
        const row: Record<string, unknown> = {
          id: vals.id ?? `row-${Math.random().toString(36).slice(2, 10)}`,
          created_at: new Date(),
        };
        for (const [k, v] of Object.entries(vals)) {
          row[snakeKey(k)] = v;
        }
        if (table.__name === 'x402Intents') {
          // Backfill columns that the SQL DEFAULTs would set.
          row.consumed_at = row.consumed_at ?? null;
          row.consuming_tx_hash = row.consuming_tx_hash ?? null;
          tables.x402Intents.push(row as unknown as IntentRow);
        } else {
          row.is_active = row.is_active ?? true;
          tables.x402Routes.push(row as unknown as RouteRow);
        }
        return [toCamelCase(row)];
      },
    }),
  });

  const select = () => ({
    from: (table: { __name: 'x402Intents' | 'x402Routes' }) => {
      return {
        where: (pred: ((row: Row) => boolean) | unknown) => {
          lastWhereFilter = typeof pred === 'function' ? (pred as (r: Row) => boolean) : null;
          const rows = (
            (table.__name === 'x402Intents'
              ? tables.x402Intents
              : tables.x402Routes) as unknown as Row[]
          ).filter(lastWhereFilter ?? (() => true));
          const result = rows.map(toCamelCase);
          // .where() resolves AND has .limit().
          const thenable = Object.assign(Promise.resolve(result), {
            limit: async (n: number) => result.slice(0, n),
          });
          return thenable;
        },
      };
    },
  });

  const update = (table: { __name: 'x402Intents' | 'x402Routes' }) => ({
    set: (patch: Row) => ({
      where: (pred: ((row: Row) => boolean) | unknown) => ({
        returning: async (_proj: Row): Promise<Row[]> => {
          if (nextUniqueViolation) {
            nextUniqueViolation = false;
            const err = new Error('unique violation') as Error & {
              code?: string;
            };
            err.code = '23505';
            throw err;
          }
          const rows =
            table.__name === 'x402Intents'
              ? (tables.x402Intents as unknown as Row[])
              : (tables.x402Routes as unknown as Row[]);
          const filter = typeof pred === 'function' ? (pred as (r: Row) => boolean) : () => true;
          const matched = rows.filter(filter);
          for (const r of matched) {
            for (const [k, v] of Object.entries(patch)) {
              r[snakeKey(k)] = v;
            }
          }
          return matched.map(toCamelCase);
        },
      }),
    }),
  });

  // The schema columns the predicates would compare on. Each is named
  // both camelCase (as the service imports it) and snake_case (as the
  // mock predicate would inspect a row). For our mock, the predicate
  // builders below return JS functions, so the schema refs themselves
  // only need to be stable references.
  const intentColumns = {
    id: 'id',
    clientId: 'client_id',
    consumedAt: 'consumed_at',
    expiresAt: 'expires_at',
  };
  const routeColumns = {
    id: 'id',
    clientId: 'client_id',
    pathPattern: 'path_pattern',
    isActive: 'is_active',
  };

  return {
    db: { insert, select, update },
    schema: {
      x402Intents: { __name: 'x402Intents' as const, ...intentColumns },
      x402Routes: { __name: 'x402Routes' as const, ...routeColumns },
    },
    // Predicate builders: each returns a function that closes over the
    // intended comparison and is later executed by .where() against an
    // in-memory row. This is enough for the small predicate space the
    // service uses (eq, and, isNull, sql for `expires_at > now()`).
    eq: (col: string, val: unknown) => (row: Record<string, unknown>) => row[col] === val,
    and:
      (...preds: Array<(row: Record<string, unknown>) => boolean>) =>
      (row: Record<string, unknown>) =>
        preds.every((p) => (typeof p === 'function' ? p(row) : true)),
    isNull: (col: string) => (row: Record<string, unknown>) => row[col] === null,
    // sql tag used for `${col} > now()`. Heuristic: the only sql() in
    // the service is the expiry check, so close over `expires_at` and
    // return a predicate. Strings/arrays from the template literal are
    // dropped — the predicate only runs the date comparison.
    sql:
      (..._args: unknown[]) =>
      (row: Record<string, unknown>) => {
        const exp = row.expires_at;
        return exp instanceof Date ? exp.getTime() > Date.now() : true;
      },
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

import { X402_INTENT_TTL_SECONDS } from './x402Intent.service.ts';
import {
  consumeIntent,
  createIntent,
  createRoute,
  deleteRoute,
  findIntent,
  findRoute,
  listRoutes,
} from './x402Intent.service.ts';

const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const PAYEE = 'rEHMTjmCNgxiGzgUTpV4Y1MwYpFpYz7e7p';
const TX_HASH_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TX_HASH_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const VALID_MPT_ID = '000004C463C52827307480341125DA0577DEFC38405B0E07';

beforeEach(() => {
  tables.x402Intents = [];
  tables.x402Routes = [];
  lastWhereFilter = null;
  nextUniqueViolation = false;
});

describe('createIntent', () => {
  it('mints an intent with a derived destination tag and TTL', async () => {
    const before = Date.now();
    const intent = await createIntent({
      resourcePath: '/v1/x402-demo/echo',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '10000',
      clientId: CLIENT_ID,
    });
    const after = Date.now();

    expect(intent.id).toMatch(/^x402_intent_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(intent.payeeAddress).toBe(PAYEE);
    expect(intent.assetKind).toBe('xrp');
    expect(intent.assetKey).toBeNull();
    expect(intent.amount).toBe('10000');
    expect(intent.consumedAt).toBeNull();
    expect(intent.consumingTxHash).toBeNull();
    expect(intent.clientId).toBe(CLIENT_ID);

    // TTL: expiresAt should be ~now + X402_INTENT_TTL_SECONDS.
    const expMs = intent.expiresAt.getTime();
    expect(expMs).toBeGreaterThanOrEqual(before + X402_INTENT_TTL_SECONDS * 1000);
    expect(expMs).toBeLessThanOrEqual(after + X402_INTENT_TTL_SECONDS * 1000 + 50);
  });

  it('persists MPT asset reference with upper-cased key', async () => {
    const intent = await createIntent({
      resourcePath: '/v1/x402-demo/echo',
      payeeAddress: PAYEE,
      asset: `mpt:${VALID_MPT_ID.toLowerCase()}`,
      amount: '42',
    });
    expect(intent.assetKind).toBe('mpt');
    expect(intent.assetKey).toBe(VALID_MPT_ID);
    expect(intent.clientId).toBeNull(); // Mode B
  });

  it('rejects unsupported asset reference (IOU out of scope)', async () => {
    await expect(
      createIntent({
        resourcePath: '/x',
        payeeAddress: PAYEE,
        asset: 'USD:rIssuer',
        amount: '1',
      }),
    ).rejects.toThrow(/unsupported asset/);
  });
});

describe('findIntent', () => {
  it('round-trips through createIntent', async () => {
    const created = await createIntent({
      resourcePath: '/x',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '1',
      clientId: CLIENT_ID,
    });
    const fetched = await findIntent(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.destinationTag).toBe(created.destinationTag);
  });

  it('returns null for an unknown intent id', async () => {
    const got = await findIntent('x402_intent_00000000000000000000000000');
    expect(got).toBeNull();
  });
});

describe('consumeIntent', () => {
  it('succeeds on first call', async () => {
    const intent = await createIntent({
      resourcePath: '/x',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '1',
      clientId: CLIENT_ID,
    });
    const ok = await consumeIntent(intent.id, TX_HASH_A);
    expect(ok).toBe(true);
    const after = await findIntent(intent.id);
    expect(after?.consumedAt).toBeInstanceOf(Date);
    expect(after?.consumingTxHash).toBe(TX_HASH_A);
  });

  it('returns false on a second call (claim-once gate)', async () => {
    const intent = await createIntent({
      resourcePath: '/x',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '1',
      clientId: CLIENT_ID,
    });
    expect(await consumeIntent(intent.id, TX_HASH_A)).toBe(true);
    expect(await consumeIntent(intent.id, TX_HASH_B)).toBe(false);
    // First-write-wins: consuming_tx_hash stays at the first claimant.
    const after = await findIntent(intent.id);
    expect(after?.consumingTxHash).toBe(TX_HASH_A);
  });

  it('returns false when the intent has expired', async () => {
    const intent = await createIntent({
      resourcePath: '/x',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '1',
      clientId: CLIENT_ID,
    });
    // Backdate the row to before now.
    const row = tables.x402Intents.find((r) => r.id === intent.id);
    if (row) row.expires_at = new Date(Date.now() - 1000);
    expect(await consumeIntent(intent.id, TX_HASH_A)).toBe(false);
  });

  it('returns false on Postgres unique-violation (cross-intent dedup)', async () => {
    const intent = await createIntent({
      resourcePath: '/x',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '1',
      clientId: CLIENT_ID,
    });
    nextUniqueViolation = true;
    const ok = await consumeIntent(intent.id, TX_HASH_A);
    expect(ok).toBe(false);
  });
});

describe('routes CRUD', () => {
  it('createRoute persists and round-trips through listRoutes', async () => {
    const route = await createRoute({
      clientId: CLIENT_ID,
      pathPattern: '/v1/x402-demo/echo',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '10000',
    });
    const all = await listRoutes(CLIENT_ID);
    expect(all.map((r) => r.id)).toContain(route.id);
    expect(all[0]?.priceAmount).toBe('10000');
  });

  it('findRoute matches by (clientId, path) when active', async () => {
    await createRoute({
      clientId: CLIENT_ID,
      pathPattern: '/v1/x402-demo/echo',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '10000',
    });
    const found = await findRoute(CLIENT_ID, '/v1/x402-demo/echo');
    expect(found).not.toBeNull();
    expect(found?.pathPattern).toBe('/v1/x402-demo/echo');
  });

  it('findRoute returns null for unknown path', async () => {
    await createRoute({
      clientId: CLIENT_ID,
      pathPattern: '/v1/x402-demo/echo',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '10000',
    });
    expect(await findRoute(CLIENT_ID, '/unknown')).toBeNull();
  });

  it('findRoute filters out soft-deleted routes', async () => {
    const r = await createRoute({
      clientId: CLIENT_ID,
      pathPattern: '/p',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '1',
    });
    expect(await deleteRoute(CLIENT_ID, r.id)).toBe(true);
    expect(await findRoute(CLIENT_ID, '/p')).toBeNull();
  });

  it('deleteRoute returns false for non-matching client (no cross-tenant delete)', async () => {
    const r = await createRoute({
      clientId: CLIENT_ID,
      pathPattern: '/p',
      payeeAddress: PAYEE,
      asset: 'XRP',
      amount: '1',
    });
    const other = '00000000-0000-0000-0000-000000000099';
    expect(await deleteRoute(other, r.id)).toBe(false);
    // And the original route is still active.
    expect(await findRoute(CLIENT_ID, '/p')).not.toBeNull();
  });
});
