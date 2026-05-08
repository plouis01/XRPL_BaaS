// Drizzle DB client backed by Neon's WebSocket Pool (neon-serverless).
//
// Why this driver and not raw postgres-js or the HTTP driver:
//
//   - postgres-js (TCP pool): the path Fly→Neon goes through middleboxes
//     that silently drop idle TCP flows. Long-lived sockets go half-open;
//     postgres-js then either throws `null is not an object (evaluating
//     'socket.write')` (crashes Bun) or hangs forever waiting for a reply.
//     That manifested as Cloudflare 502s and infinite dashboard spinners.
//
//   - neon-http: each query is a fresh HTTPS request, so no socket
//     staleness — but it has no transaction support (drizzle throws
//     "No transactions support in neon-http driver" on `db.transaction()`).
//     We use transactions in 13 places (agent provisioning, account create,
//     etc.) so this driver is a non-starter.
//
// neon-serverless Pool is the right answer:
//   - WebSocket protocol with built-in ping/pong frames keeps the
//     connection alive across NAT/middlebox TTLs.
//   - `pg`-compatible client → drizzle's full `db.transaction(cb)`
//     semantics work normally (BEGIN ... COMMIT, intermediate `.returning()`
//     results visible mid-tx, etc.).
//   - Pool transparently reconnects on transient WebSocket errors.
//
// Bun runtime note: neon-serverless needs a WebSocket constructor. Bun's
// global `WebSocket` works directly — no `ws` package shim required.
//
// Migrations: drizzle-kit (`bun run db:migrate`) uses its own driver via
// drizzle.config.ts and is unaffected by this change.
//
// Lazy initialization preserved so tests and tooling that import schema
// shapes don't need DATABASE_URL.

import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema.ts';

// Bun ships a spec-compliant global WebSocket. neonConfig defaults to
// looking for `ws` (the npm package), which we don't need or want. Setting
// it explicitly avoids a "ws not found" import error at first query.
if (
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'
) {
  // biome-ignore lint/suspicious/noExplicitAny: neonConfig.webSocketConstructor types don't perfectly match Bun/native WS but are runtime-compatible
  neonConfig.webSocketConstructor = (globalThis as any).WebSocket;
}

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let drizzleClient: DrizzleDb | null = null;
let pool: Pool | null = null;

function initialize(): DrizzleDb {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is required to use @railforge/db. Set it in .env or process.env before the first DB call.',
    );
  }
  // Pool sizing: 10 is fine for our throughput (single Fly VM, < 200 RPS).
  // The WebSocket protocol carries its own keepalive frames, but we still
  // recycle on idle as a defensive belt-and-suspenders against any
  // middlebox that ignores those frames.
  pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  drizzleClient = drizzle(pool, { schema });
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
 * Test/teardown helper. Closes the underlying WebSocket pool so vitest
 * doesn't hang on open handles. Resets the singleton so a fresh client is
 * created on next use.
 */
export async function disconnectDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
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
