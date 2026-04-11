// Tests for the pre-auth IP rate limiter. This middleware is the only thing
// stopping anonymous brute-force traffic from hammering the auth lookup, so
// the test bar is high.

import { Hono } from 'hono';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const mockRedis = new RedisMock();
vi.mock('../redis.ts', () => ({
  getRedis: () => mockRedis,
  disconnectRedis: async () => {},
}));

// Silence the logger so failure-path tests don't spam stdout.
vi.mock('../logger.ts', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const { ipRateLimit } = await import('./ipRateLimit.ts');
const { memoryRateLimiter } = await import('./memoryRateLimit.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', ipRateLimit);
  app.get('/v1/anything', (c) => c.json({ ok: true }));
  return app;
}

describe('ipRateLimit middleware', () => {
  beforeEach(async () => {
    await mockRedis.flushall();
    // Module-level singleton: reset so the fallback state from a prior
    // test doesn't leak into the current one.
    memoryRateLimiter.reset();
    process.env.IP_RATE_LIMIT = '5'; // tight limit for tests
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be removed so the next test sees the default
    delete process.env.IP_RATE_LIMIT;
    vi.clearAllMocks();
  });

  it('allows requests under the limit (no headers leaked about the budget)', async () => {
    const app = makeApp();
    const res = await app.request('/v1/anything', {
      headers: { 'cf-connecting-ip': '203.0.113.1' },
    });
    expect(res.status).toBe(200);
    // The IP limiter intentionally does NOT emit X-RateLimit-* headers —
    // those are reserved for the per-key limiter and would just confirm to
    // an attacker how close they are to the threshold.
    expect(res.headers.get('x-ratelimit-limit')).toBeNull();
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it('returns 429 with Retry-After once the limit is exceeded', async () => {
    const app = makeApp();
    const ip = { 'cf-connecting-ip': '203.0.113.2' };

    // Burn through the limit (5 requests).
    for (let i = 0; i < 5; i++) {
      const r = await app.request('/v1/anything', { headers: ip });
      expect(r.status).toBe(200);
    }

    const blocked = await app.request('/v1/anything', { headers: ip });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    const body = (await blocked.json()) as {
      error: string;
      retry_after_seconds: number;
    };
    expect(body).toMatchObject({ error: 'Too many requests' });
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  it('isolates buckets per source IP', async () => {
    const app = makeApp();

    // Burn through IP 1's budget.
    for (let i = 0; i < 6; i++) {
      await app.request('/v1/anything', {
        headers: { 'cf-connecting-ip': '203.0.113.10' },
      });
    }

    // IP 2 must still be admitted.
    const ok = await app.request('/v1/anything', {
      headers: { 'cf-connecting-ip': '203.0.113.11' },
    });
    expect(ok.status).toBe(200);
  });

  it('prefers cf-connecting-ip over x-forwarded-for', async () => {
    const app = makeApp();

    // Drain CF IP "A".
    for (let i = 0; i < 6; i++) {
      await app.request('/v1/anything', {
        headers: { 'cf-connecting-ip': 'A', 'x-forwarded-for': 'B' },
      });
    }
    // CF IP "A" exceeds — should 429.
    const blocked = await app.request('/v1/anything', {
      headers: { 'cf-connecting-ip': 'A', 'x-forwarded-for': 'B' },
    });
    expect(blocked.status).toBe(429);

    // XFF "B" alone should still work — proves we used CF, not XFF, for "A".
    const ok = await app.request('/v1/anything', {
      headers: { 'x-forwarded-for': 'B' },
    });
    expect(ok.status).toBe(200);
  });

  it('falls back to x-forwarded-for when cf-connecting-ip is absent (first hop only)', async () => {
    const app = makeApp();
    const xff = '203.0.113.50, 10.0.0.1, 10.0.0.2';

    // Drain bucket using full XFF chain.
    for (let i = 0; i < 6; i++) {
      await app.request('/v1/anything', {
        headers: { 'x-forwarded-for': xff },
      });
    }
    const blocked = await app.request('/v1/anything', {
      headers: { 'x-forwarded-for': xff },
    });
    expect(blocked.status).toBe(429);

    // Same chain should remain blocked because the limiter keys on the first
    // entry, not the whole chain.
    const sameFirstHop = await app.request('/v1/anything', {
      headers: { 'x-forwarded-for': '203.0.113.50' },
    });
    expect(sameFirstHop.status).toBe(429);
  });

  it('groups requests with no IP headers into the "unknown" bucket (safe default)', async () => {
    const app = makeApp();

    // 6 unknown-IP requests should still be rate-limited as one bucket —
    // we never let unknown sources bypass.
    for (let i = 0; i < 5; i++) {
      const r = await app.request('/v1/anything');
      expect(r.status).toBe(200);
    }
    const blocked = await app.request('/v1/anything');
    expect(blocked.status).toBe(429);
  });

  // Sprint 7 #16: the pre-auth limiter is the ONLY thing standing between
  // anonymous traffic and the auth lookup. When Redis is down, the old
  // behavior was to fail open — an attacker during a Redis outage got
  // effectively unlimited guesses against the auth endpoint. Now the
  // in-memory fallback enforces the limit per-process.

  describe('redis failure fallback', () => {
    it('enforces the per-IP limit via in-memory fallback when exec() throws', async () => {
      const app = makeApp();
      const ip = { 'cf-connecting-ip': '203.0.113.99' };

      const spy = vi.spyOn(mockRedis, 'multi').mockImplementation(() => {
        // biome-ignore lint/suspicious/noExplicitAny: stubbing ioredis' fluent builder
        const failing: any = {
          zremrangebyscore: () => failing,
          zadd: () => failing,
          zcard: () => failing,
          expire: () => failing,
          exec: async () => {
            throw new Error('connection refused');
          },
        };
        return failing;
      });

      // Burn through the limit (5).
      for (let i = 0; i < 5; i++) {
        const r = await app.request('/v1/anything', { headers: ip });
        expect(r.status).toBe(200);
      }

      // The 6th hit must be blocked by the fallback, not admitted.
      const blocked = await app.request('/v1/anything', { headers: ip });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe('60');

      spy.mockRestore();
    });

    it('isolates fallback buckets per IP during a redis outage', async () => {
      const app = makeApp();

      const spy = vi.spyOn(mockRedis, 'multi').mockImplementation(() => {
        // biome-ignore lint/suspicious/noExplicitAny: stubbing ioredis' fluent builder
        const failing: any = {
          zremrangebyscore: () => failing,
          zadd: () => failing,
          zcard: () => failing,
          expire: () => failing,
          exec: async () => {
            throw new Error('connection refused');
          },
        };
        return failing;
      });

      // Drain IP A's fallback bucket.
      for (let i = 0; i < 6; i++) {
        await app.request('/v1/anything', {
          headers: { 'cf-connecting-ip': '203.0.113.100' },
        });
      }
      // IP B must still be admitted — the fallback map keys per IP.
      const ok = await app.request('/v1/anything', {
        headers: { 'cf-connecting-ip': '203.0.113.101' },
      });
      expect(ok.status).toBe(200);

      spy.mockRestore();
    });

    it('falls back when exec() resolves null (pipeline rejected cleanly)', async () => {
      const app = makeApp();
      const ip = { 'cf-connecting-ip': '203.0.113.102' };

      const spy = vi.spyOn(mockRedis, 'multi').mockImplementation(() => {
        // biome-ignore lint/suspicious/noExplicitAny: stubbing ioredis' fluent builder
        const failing: any = {
          zremrangebyscore: () => failing,
          zadd: () => failing,
          zcard: () => failing,
          expire: () => failing,
          exec: async () => null,
        };
        return failing;
      });

      // Burn through the limit again via the null-result path.
      for (let i = 0; i < 5; i++) {
        const r = await app.request('/v1/anything', { headers: ip });
        expect(r.status).toBe(200);
      }
      const blocked = await app.request('/v1/anything', { headers: ip });
      expect(blocked.status).toBe(429);

      spy.mockRestore();
    });
  });
});
