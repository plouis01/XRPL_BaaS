#!/usr/bin/env bun
// Seed the local dev database with one client and one API key.
//
// Usage:
//   bun run scripts/seed-dev.ts
//
// The raw API key is printed ONCE — copy it into your curl test immediately.
// Re-running this script produces a fresh key and revokes the previous one.
//
// CRITICAL: this script uses the SAME HMAC-SHA256 + API_KEY_SALT scheme as
// apps/api/src/middleware/auth.ts. If that scheme ever changes, this file
// must change with it or seeded keys will fail to authenticate.

import { createHmac, randomBytes } from "node:crypto";
// Relative import: scripts/ is not a workspace package, so @railforge/db
// doesn't resolve. This is the only place in the repo that uses a relative
// import across the package boundary — app code always uses @railforge/db.
import { and, db, eq, isNull, schema } from "../packages/db/src/index.ts";

const SALT = process.env.API_KEY_SALT;
if (!SALT) {
  console.error("ERROR: API_KEY_SALT is required. Source .env first:");
  console.error(
    '  export $(grep -v "^#" .env | xargs) && bun run scripts/seed-dev.ts',
  );
  process.exit(1);
}

const SEED_CLIENT_EMAIL = "dev@railforge.local";
const SEED_CLIENT_NAME = "Sprint 2 dev client";

// ── 1. Generate a new raw API key ───────────────────────────────────────────
// Format: rf_<env>_<44-char-base64url>. 32 random bytes = 256 bits entropy.
// The `rf_test_` prefix lets the auth middleware's key-prefix logging work.
const rawKey = `rf_test_${randomBytes(32).toString("base64url")}`;
const keyHash = createHmac("sha256", SALT).update(rawKey).digest("hex");
const keyPrefix = rawKey.slice(0, 8);

// ── 2. Upsert the dev client ────────────────────────────────────────────────
const existingClient = await db
  .select({ id: schema.clients.id })
  .from(schema.clients)
  .where(eq(schema.clients.email, SEED_CLIENT_EMAIL))
  .limit(1);

let clientId: string;
if (existingClient[0]) {
  clientId = existingClient[0].id;
  console.log(`→ Reusing existing client ${clientId} (${SEED_CLIENT_EMAIL})`);
} else {
  const inserted = await db
    .insert(schema.clients)
    .values({
      name: SEED_CLIENT_NAME,
      email: SEED_CLIENT_EMAIL,
      plan: "free",
    })
    .returning({ id: schema.clients.id });
  clientId = inserted[0]!.id;
  console.log(`→ Created client ${clientId} (${SEED_CLIENT_EMAIL})`);
}

// ── 3. Revoke any active keys for this client ──────────────────────────────
// Guarantees only ONE active key per seed run, so the previous key stops
// working when you re-seed. Prevents accidental auth with a stale key.
const revokedCount = await db
  .update(schema.apiKeys)
  .set({ revokedAt: new Date() })
  .where(
    and(
      eq(schema.apiKeys.clientId, clientId),
      isNull(schema.apiKeys.revokedAt),
    ),
  )
  .returning({ id: schema.apiKeys.id });

if (revokedCount.length > 0) {
  console.log(`→ Revoked ${revokedCount.length} previous key(s)`);
}

// ── 4. Insert the new key ───────────────────────────────────────────────────
const newKey = await db
  .insert(schema.apiKeys)
  .values({
    clientId,
    keyHash,
    keyPrefix,
    label: `seed-dev ${new Date().toISOString()}`,
    environment: "testnet",
    rateLimit: 1000, // generous limit for dev testing
    isActive: true,
  })
  .returning({ id: schema.apiKeys.id });

console.log(`→ Created API key ${newKey[0]!.id}`);

// ── 5. Print the raw key ONCE ───────────────────────────────────────────────
console.log("");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  API KEY (copy now — will not be shown again)");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  ${rawKey}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("");
console.log("Test it with:");
console.log(`  curl -H 'X-API-Key: ${rawKey}' \\`);
console.log(`       -H 'Idempotency-Key: test-$(date +%s)' \\`);
console.log(`       -H 'Content-Type: application/json' \\`);
console.log(`       -d '{"label":"test-wallet"}' \\`);
console.log(`       http://localhost:3000/v1/accounts`);
console.log("");

process.exit(0);
