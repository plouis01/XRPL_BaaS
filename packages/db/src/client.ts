// Drizzle DB client backed by Neon's HTTP driver.
//
// Why HTTP and not the postgres-js TCP pool: Neon's compute scales to zero
// after ~5 min of idle, and the path Fly→Neon goes through middleboxes that
// silently drop idle TCP flows. With long-lived TCP, a half-open socket
// causes postgres-js to either throw `null is not an object (evaluating
// 'socket.write')` (which crashes Bun) or — worse — hang forever waiting
// for a reply that never arrives. That manifested as Cloudflare 502s and
// infinite dashboard spinners on every other agent provision.
//
// HTTP avoids the whole class of bug. Each query is a fresh HTTPS request
// to Neon's serverless gateway: open, send, receive, close. There's no
// connection state to go stale, no pool to poison, no TCP keepalive to
// argue about with NAT TTLs. Cold-start latency adds ~10–30ms vs raw TCP,
// which is acceptable here.
//
// Transactions: drizzle's `db.transaction(cb)` API works on neon-http —
// the entire transaction is serialized into a single HTTP request that
// Neon executes server-side as `BEGIN ... COMMIT`. Constraint: you cannot
// `await` non-DB work inside a transaction (network I/O, etc.) because the
// whole tx is one HTTP call. Our existing transactions only do DB ops, so
// this is a non-change.
//
// Migrations: drizzle-kit (`bun run db:migrate`) uses its own driver and
// is unaffected by this change.
//
// Lazy initialization preserved so tests and tooling that import schema
// shapes don't need DATABASE_URL.

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.ts';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let drizzleClient: DrizzleDb | null = null;

function initialize(): DrizzleDb {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is required to use @railforge/db. Set it in .env or process.env before the first DB call.',
    );
  }
  const sql = neon(url);
  drizzleClient = drizzle(sql, { schema });
  return drizzleClient;
}

/**
 * Lazy DB proxy. Forwards every property access to a real Drizzle client that
 * is created on first use. Tests and tooling that import schema/types but
 * never actually query do NOT trigger initialization.
 */
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    const real = drizzleClient ?? initialize();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

/**
 * Test/teardown helper. The HTTP driver doesn't hold a long-lived socket so
 * there's nothing to close — we just drop the singleton so the next call
 * to `db.<anything>` re-initializes (useful for tests that swap DATABASE_URL).
 */
export async function disconnectDb(): Promise<void> {
  drizzleClient = null;
}

/**
 * Compare migration files (the SQL in `migrations/`) against the
 * `drizzle.__drizzle_migrations` table on the live DB. Drift means the
 * file count exceeds the applied count — a missing migration the next
 * deploy needs OR (worse, what bit us in May 2026) a journal that
 * silently no-ops because manual edits desynchronized it.
 *
 * Returns a structured result instead of throwing — apps decide whether
 * drift is fatal (fail the boot) or just a warn-and-continue. Today it's
 * advisory; mainnet rollout could escalate to fatal.
 *
 * Implementation note: walks the journal entries (idx → tag) rather than
 * the filesystem so it works post-bundle in shipped containers, where
 * the SQL files may be packed but the journal is included.
 */
export interface MigrationDriftResult {
  journalCount: number;
  appliedCount: number;
  drift: boolean;
  /** If drift is true, the tags that the journal lists but DB doesn't have. */
  missingTags?: string[];
}

export async function checkMigrationDrift(): Promise<MigrationDriftResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');

  // The journal lives at packages/db/src/migrations/meta/_journal.json.
  // Resolve relative to this module so the check works whether the app
  // is running from source (tsx/bun) or from a bundled dist/.
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const journalPath = path.join(here, 'migrations', 'meta', '_journal.json');
  let journal: { entries: Array<{ idx: number; tag: string }> };
  try {
    journal = JSON.parse(await fs.readFile(journalPath, 'utf-8'));
  } catch {
    // No journal on disk — treat as "nothing to verify" rather than
    // failing. Bundled deployments without the meta dir hit this path.
    return { journalCount: 0, appliedCount: 0, drift: false };
  }
  const journalCount = journal.entries.length;

  // The applied table is named `drizzle.__drizzle_migrations` per the
  // default drizzle-kit settings. Use raw sql to avoid declaring it in
  // the schema (it's drizzle-internal).
  const real = drizzleClient ?? initialize();
  const { sql } = await import('drizzle-orm');
  // neon-http's execute() returns a NeonHttpQueryResult — rows live on
  // `.rows`. The previous postgres-js driver returned the array directly.
  const result = await real.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
  );
  const rows = (result as unknown as { rows?: Array<{ count: string }> }).rows ?? [];
  const appliedCount = Number.parseInt(rows[0]?.count ?? '0', 10);

  if (journalCount === appliedCount) {
    return { journalCount, appliedCount, drift: false };
  }
  // For the mismatch case, identify which journal entries (by tag) likely
  // didn't apply. We compare counts — drizzle stamps applied migrations
  // sequentially so tags >= appliedCount are the unapplied ones.
  const missingTags = journal.entries.slice(appliedCount).map((e) => e.tag);
  return { journalCount, appliedCount, drift: true, missingTags };
}

export type Database = DrizzleDb;
