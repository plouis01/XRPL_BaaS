#!/usr/bin/env bun
// Generate a RailForge API key and insert it into the database.
//
// Usage:
//   bun run scripts/generate-api-key.ts --client-id <uuid> [--env testnet|mainnet] [--label <label>]
//
// The script:
//   1. Generates a cryptographically random key: rf_{env}_{32+ alphanumeric chars}
//   2. HMAC-SHA256 hashes it with API_KEY_SALT (same algorithm as auth.ts)
//   3. Inserts the hash + prefix into api_keys
//   4. Prints the raw key ONCE to stdout — it cannot be recovered after this
//
// Requires: DATABASE_URL and API_KEY_SALT in .env (or environment).

import { createHmac, randomBytes } from "node:crypto";
import { db, schema } from "@railforge/db";

const KEY_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY_RANDOM_LENGTH = 32;

// Format: rf_test_<random> or rf_live_<random>
const KEY_REGEX = /^rf_(test|live)_[A-Za-z0-9]{32,}$/;

function generateRandomString(length: number): string {
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += KEY_CHARSET[bytes[i]! % KEY_CHARSET.length];
  }
  return result;
}

function hashApiKey(rawKey: string): string {
  const salt = process.env.API_KEY_SALT;
  if (!salt) {
    console.error("ERROR: API_KEY_SALT is required. Set it in .env.");
    process.exit(1);
  }
  return createHmac("sha256", salt).update(rawKey).digest("hex");
}

function parseArgs(): {
  clientId: string;
  environment: "testnet" | "mainnet";
  label: string | null;
} {
  const args = process.argv.slice(2);
  let clientId = "";
  let environment: "testnet" | "mainnet" = "testnet";
  let label: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--client-id":
        clientId = args[++i] ?? "";
        break;
      case "--env":
        {
          const val = args[++i];
          if (val !== "testnet" && val !== "mainnet") {
            console.error('ERROR: --env must be "testnet" or "mainnet"');
            process.exit(1);
          }
          environment = val;
        }
        break;
      case "--label":
        label = args[++i] ?? null;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!clientId) {
    console.error(
      "Usage: bun run scripts/generate-api-key.ts --client-id <uuid> [--env testnet|mainnet] [--label <label>]",
    );
    process.exit(1);
  }

  return { clientId, environment, label };
}

async function main(): Promise<void> {
  const { clientId, environment, label } = parseArgs();

  // Verify the client exists.
  const { eq } = await import("drizzle-orm");
  const clientRows = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId))
    .limit(1);

  if (clientRows.length === 0) {
    console.error(`ERROR: no client found with id ${clientId}`);
    process.exit(1);
  }

  // Generate the key.
  const envPrefix = environment === "mainnet" ? "live" : "test";
  const rawKey = `rf_${envPrefix}_${generateRandomString(KEY_RANDOM_LENGTH)}`;

  // Validate format.
  if (!KEY_REGEX.test(rawKey)) {
    console.error("BUG: generated key does not match expected format");
    process.exit(1);
  }

  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 8);

  // Insert into DB.
  const inserted = await db
    .insert(schema.apiKeys)
    .values({
      clientId,
      keyHash,
      keyPrefix,
      environment,
      label,
    })
    .returning({ id: schema.apiKeys.id });

  const apiKeyId = inserted[0]?.id;
  if (!apiKeyId) {
    console.error("ERROR: insert returned no row");
    process.exit(1);
  }

  // Print the raw key ONCE. It cannot be recovered.
  console.log("");
  console.log("API key generated successfully.");
  console.log("");
  console.log(`  Key ID:      ${apiKeyId}`);
  console.log(`  Client ID:   ${clientId}`);
  console.log(`  Environment: ${environment}`);
  console.log(`  Label:       ${label ?? "(none)"}`);
  console.log("");
  console.log(`  Raw key:     ${rawKey}`);
  console.log("");
  console.log("  ⚠  Save this key now — it cannot be recovered.");
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
