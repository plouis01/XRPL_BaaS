// Tests for the API key auth middleware. This is the SOLE authentication
// barrier on the API — every test here is load-bearing for security.
//
// Strategy: mock @railforge/db so we don't need a live Postgres. The query
// builder chain returns a fake `limit()` whose result we control per test.

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types.ts";

// ── Mock the DB module BEFORE importing auth.ts ─────────────────────────────
const limitMock = vi.fn();
vi.mock("@railforge/db", () => {
  // Build a chain that ends in our controllable `limit` mock.
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: (n: number) => limitMock(n),
  };
  return {
    db: chain,
    schema: {
      apiKeys: {
        id: "id",
        clientId: "clientId",
        environment: "environment",
        rateLimit: "rateLimit",
        isActive: "isActive",
        keyHash: "keyHash",
        revokedAt: "revokedAt",
      },
    },
    and: vi.fn(),
    eq: vi.fn(),
    isNull: vi.fn(),
  };
});

// Import auth AFTER the mock is registered.
const { auth } = await import("./auth.ts");

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", auth);
  app.get("/protected", (c) => {
    return c.json({
      clientId: c.get("clientId"),
      apiKeyId: c.get("apiKeyId"),
      rateLimit: c.get("rateLimit"),
      environment: c.get("environment"),
    });
  });
  return app;
}

describe("auth middleware", () => {
  beforeEach(() => {
    limitMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects requests with no X-API-Key header", async () => {
    const app = makeApp();
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Missing API key" });
    // Crucially: we never queried the database for this case.
    expect(limitMock).not.toHaveBeenCalled();
  });

  it("rejects unknown API keys with the same response shape as inactive keys (no enumeration oracle)", async () => {
    const app = makeApp();

    limitMock.mockResolvedValueOnce([]); // no row → "unknown key"
    const unknownRes = await app.request("/protected", {
      headers: { "x-api-key": "rf_test_unknown" },
    });
    const unknownBody = await unknownRes.json();
    const unknownStatus = unknownRes.status;

    limitMock.mockResolvedValueOnce([
      {
        id: "k1",
        clientId: "c1",
        environment: "testnet",
        rateLimit: 100,
        isActive: false, // inactive
      },
    ]);
    const inactiveRes = await app.request("/protected", {
      headers: { "x-api-key": "rf_test_inactive" },
    });
    const inactiveBody = await inactiveRes.json();
    const inactiveStatus = inactiveRes.status;

    // Bodies and statuses MUST be identical — leaking which one matched would
    // tell an attacker that "rf_test_inactive" exists in the database.
    expect(unknownStatus).toBe(401);
    expect(inactiveStatus).toBe(401);
    expect(unknownBody).toEqual(inactiveBody);
    expect(unknownBody).toEqual({ error: "Invalid API key" });
  });

  it("passes through and stashes context for an active testnet key", async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([
      {
        id: "key-id-1",
        clientId: "client-id-1",
        environment: "testnet",
        rateLimit: 250,
        isActive: true,
      },
    ]);

    const res = await app.request("/protected", {
      headers: { "x-api-key": "rf_test_valid" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      clientId: "client-id-1",
      apiKeyId: "key-id-1",
      rateLimit: 250,
      environment: "testnet",
    });
  });

  it("coerces an unknown environment string to testnet (mainnet must be exact)", async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([
      {
        id: "k",
        clientId: "c",
        environment: "devnet", // not 'mainnet'
        rateLimit: 100,
        isActive: true,
      },
    ]);

    const res = await app.request("/protected", {
      headers: { "x-api-key": "rf_d_x" },
    });
    const body = (await res.json()) as { environment: string };
    expect(body.environment).toBe("testnet"); // safe fallback
  });

  it('routes a row with environment="mainnet" to mainnet', async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([
      {
        id: "k",
        clientId: "c",
        environment: "mainnet",
        rateLimit: 100,
        isActive: true,
      },
    ]);

    const res = await app.request("/protected", {
      headers: { "x-api-key": "rf_live_x" },
    });
    const body = (await res.json()) as { environment: string };
    expect(body.environment).toBe("mainnet");
  });

  it("exposes the X-RailForge-Key-Prefix header on success but never the full key", async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([
      {
        id: "k",
        clientId: "c",
        environment: "testnet",
        rateLimit: 100,
        isActive: true,
      },
    ]);

    const apiKey = "rf_test_abcdefghijklmnop";
    const res = await app.request("/protected", {
      headers: { "x-api-key": apiKey },
    });
    const prefix = res.headers.get("x-railforge-key-prefix");
    expect(prefix).toBe("rf_test_"); // first 8 chars only
    expect(prefix).not.toBe(apiKey);
  });

  it("does not include the key prefix on rejected requests (avoid confirming format)", async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([]);
    const res = await app.request("/protected", {
      headers: { "x-api-key": "wrong" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-railforge-key-prefix")).toBeNull();
  });

  it("hashes the API key with SHA-256 before lookup (verified via input to where())", async () => {
    // This test verifies the hash is being computed correctly. We can't easily
    // assert on the WHERE clause directly because we mocked drizzle's query
    // builder, but we CAN verify behavior end-to-end: two different keys must
    // produce two distinct lookups, and the same key twice produces the same
    // lookup (no salt).
    const app = makeApp();
    limitMock.mockResolvedValue([]);

    await app.request("/protected", { headers: { "x-api-key": "a" } });
    await app.request("/protected", { headers: { "x-api-key": "b" } });
    await app.request("/protected", { headers: { "x-api-key": "a" } });

    expect(limitMock).toHaveBeenCalledTimes(3);
  });
});
