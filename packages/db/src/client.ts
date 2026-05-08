// Drizzle DB client. Single connection pool shared across worker/api/indexer.
//
// Lazy initialization: we DO NOT create the postgres client at module import
// time. That would force every test, schema generation, and tooling import to
// have a live DATABASE_URL — including imports that only need the schema
// shapes (auth tests, validators, etc.). Instead, the client is created on
// first access via the proxy below. The first time anything reads from `db`,
// it pulls DATABASE_URL from the env and connects.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.ts';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let drizzleClient: DrizzleDb | null = null;
let postgresClient: Sql | null = null;

function initialize(): DrizzleDb {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is required to use @railforge/db. Set it in .env or process.env before the first DB call.',
    );
  }
  // Connection-staleness defenses (post-incident hardening, May 2026).
  //
  // Neon's serverless compute scales to zero after a few minutes of idle.
  // When it does, our TCP socket goes half-open: the kernel still sees an
  // ESTABLISHED connection, but the next write fails with the underlying
  // socket being null. postgres-js v3 doesn't gracefully recover from
  // that — it throws synchronously inside `nextWrite` and Bun crashes the
  // whole process with `TypeError: null is not an object (evaluating
  // 'socket.write')`.
  //
  // The fix layers:
  //   - `idle_timeout: 30` — close any pooled connection that's been idle
  //     30s. Neon's idle window is ~5 min, so 30s is well inside the
  //     guaranteed-alive zone. Cost: a fresh handshake on the first query
  //     after a quiet stretch (~50ms vs Upstash). Worth it.
  //   - `max_lifetime: 1800` — recycle every 30 min even on busy
  //     connections, so we never keep a single socket open long enough to
  //     hit middlebox NAT TTLs (~hours typically; cheaper to be safe).
  //   - `connect_timeout: 10` — bound the cold-start handshake; better
  //     than the default 30s for our request budget.
  //
  // Note: these timeouts apply to the producer pool. They don't touch the
  // process-level uncaughtException handler in apps/api/src/index.ts —
  // that's the belt to this suspenders. If a stale socket somehow slips
  // past the timeouts, the handler logs and tolerates instead of crashing.
  postgresClient = postgres(url, {
    max: 10,
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
  });
  drizzleClient = drizzle(postgresClient, { schema });
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
 * Test/teardown helper. Closes the underlying postgres connection pool so
 * vitest doesn't hang on open handles.
 */
export async function disconnectDb(): Promise<void> {
  if (postgresClient) {
    await postgresClient.end({ timeout: 5 });
    postgresClient = null;
    drizzleClient = null;
  }
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
  const result = await real.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
  );
  const appliedCount = Number.parseInt(result[0]?.count ?? '0', 10);

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
