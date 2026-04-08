// API key authentication middleware.
//
// Wire format: clients send `X-API-Key: rf_<env>_<random>` on every /v1 request.
// We hash the raw key with SHA-256 and look it up in api_keys.key_hash. The raw
// key never touches storage — only the hash. See PLAN.md §3.1, §9.
//
// On success, stashes clientId, apiKeyId, and environment on the Hono context.

import { createHash } from "node:crypto";
import { and, db, eq, isNull, schema } from "@railforge/db";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.ts";

const KEY_PREFIX_LENGTH = 8;

export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header("x-api-key");
  if (!apiKey) {
    return c.json({ error: "Missing API key" }, 401);
  }

  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  const rows = await db
    .select({
      id: schema.apiKeys.id,
      clientId: schema.apiKeys.clientId,
      environment: schema.apiKeys.environment,
      rateLimit: schema.apiKeys.rateLimit,
      isActive: schema.apiKeys.isActive,
    })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.keyHash, keyHash),
        isNull(schema.apiKeys.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) {
    // Intentionally generic — never reveal whether the key was found, revoked,
    // or just inactive. Brute-force pattern detection is the rate limiter's job.
    return c.json({ error: "Invalid API key" }, 401);
  }

  const env = row.environment === "mainnet" ? "mainnet" : "testnet";

  c.set("clientId", row.clientId);
  c.set("apiKeyId", row.id);
  c.set("rateLimit", row.rateLimit);
  c.set("environment", env);

  // Make the prefix available to logs without exposing the full key.
  c.header("X-RailForge-Key-Prefix", apiKey.slice(0, KEY_PREFIX_LENGTH));

  await next();
  return;
};
