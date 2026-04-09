// Tests for the rate limit middleware. Sliding-window math is easy to get
// wrong; this is the only DoS defense on the API.

import { Hono } from "hono";
import RedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types.ts";

// Mock the redis singleton so the middleware uses our in-memory mock.
const mockRedis = new RedisMock();
vi.mock("../redis.ts", () => ({
  getRedis: () => mockRedis,
  disconnectRedis: async () => {},
}));

const { rateLimit } = await import("./rateLimit.ts");

function makeApp(opts: { apiKeyId: string; limit: number }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Stub the auth context that rate limit depends on.
  app.use("*", async (c, next) => {
    c.set("apiKeyId", opts.apiKeyId);
    c.set("rateLimit", opts.limit);
    c.set("clientId", "client-x");
    c.set("environment", "testnet");
    await next();
  });
  app.use("*", rateLimit);
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimit middleware", () => {
  beforeEach(async () => {
    await mockRedis.flushall();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("allows requests under the limit and sets X-RateLimit headers", async () => {
    const app = makeApp({ apiKeyId: "k1", limit: 5 });
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("5");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(res.headers.get("x-ratelimit-reset")).not.toBeNull();
  });

  it("counts each request and decrements remaining", async () => {
    const app = makeApp({ apiKeyId: "k2", limit: 3 });
    const r1 = await app.request("/ping");
    const r2 = await app.request("/ping");
    const r3 = await app.request("/ping");

    expect(r1.headers.get("x-ratelimit-remaining")).toBe("2");
    expect(r2.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(r3.headers.get("x-ratelimit-remaining")).toBe("0");

    // All three should still be 200 (under or at the limit).
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
  });

  it("returns 429 once the limit is exceeded", async () => {
    const app = makeApp({ apiKeyId: "k3", limit: 2 });
    await app.request("/ping");
    await app.request("/ping");
    const overLimit = await app.request("/ping");

    expect(overLimit.status).toBe(429);
    const body = (await overLimit.json()) as {
      error: string;
      retry_after_seconds: number;
    };
    expect(body).toMatchObject({ error: "Rate limit exceeded" });
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  it("isolates buckets by apiKeyId — one key over the limit does not affect another", async () => {
    const appA = makeApp({ apiKeyId: "kA", limit: 1 });
    const appB = makeApp({ apiKeyId: "kB", limit: 1 });

    const a1 = await appA.request("/ping");
    const a2 = await appA.request("/ping");
    const b1 = await appB.request("/ping");

    expect(a1.status).toBe(200);
    expect(a2.status).toBe(429); // kA exceeded
    expect(b1.status).toBe(200); // kB unaffected
  });

  it("drops entries older than the window so the bucket effectively resets", async () => {
    const app = makeApp({ apiKeyId: "k4", limit: 2 });

    // Manually backfill the redis ZSET with two entries from 90 seconds ago.
    // The window is 60s; both should be evicted by ZREMRANGEBYSCORE on the
    // next request.
    const ninetySecondsAgo = Date.now() - 90_000;
    const key = "railforge:rl:k4";
    await mockRedis.zadd(key, ninetySecondsAgo, "old-1");
    await mockRedis.zadd(key, ninetySecondsAgo + 100, "old-2");

    // The next request should see a clean bucket.
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("1");

    // And confirm the old entries were actually removed.
    const remaining = await mockRedis.zcard(key);
    expect(remaining).toBe(1); // only the new request
  });

  it("fails closed if auth context is missing (defense in depth)", async () => {
    const app = new Hono<AppEnv>();
    // No auth middleware — apiKeyId/rateLimit will be undefined.
    app.use("*", rateLimit);
    app.get("/ping", (c) => c.json({ ok: true }));

    const res = await app.request("/ping");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Rate limit context missing" });
  });
});
