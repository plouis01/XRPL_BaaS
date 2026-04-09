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
  postgresClient = postgres(url, { max: 10 });
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

export type Database = DrizzleDb;
