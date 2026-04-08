// Drizzle DB client. Single connection pool shared across worker/api/indexer.
// TODO Sprint 1: wire to drizzle + postgres.js.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

const queryClient = postgres(url, { max: 10 });
export const db = drizzle(queryClient, { schema });

export type Database = typeof db;
