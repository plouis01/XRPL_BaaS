// Tests for the idempotency caching middleware.
//
// Coverage:
//   1. GET requests skip the middleware entirely
//   2. POST without Idempotency-Key returns 400
//   3. POST without clientId on context returns 500 (defense in depth)
//   4. First POST runs the handler and caches the response
//   5. Second POST with the same key replays the cached response
//   6. X-Idempotent-Replay header is set on replays only
//   7. Different keys get independent buckets (no cross-key collision)
//   8. Different clients get independent buckets (no cross-tenant collision)
//   9. 5xx responses are NOT cached (transient failures must retry)

import { Hono } from 'hono';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const mockRedis = new RedisMock();
vi.mock('../redis.ts', () => ({
  getRedis: () => mockRedis,
  disconnectRedis: async () => {},
}));

const { idempotency } = await import('./idempotency.ts');

function makeApp(opts: {
  clientId?: string;
  handler?: () => Response | Promise<Response>;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Stub auth to set clientId on the context.
  app.use('*', async (c, next) => {
    if (opts.clientId) {
      c.set('clientId', opts.clientId);
      c.set('apiKeyId', 'fake-key-id');
      c.set('rateLimit', 100);
      c.set('environment', 'testnet');
    }
    await next();
  });
  app.use('*', idempotency);

  const handler =
    opts.handler ??
    (() =>
      new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }));
  // biome-ignore lint/suspicious/noExplicitAny: Hono return type is narrowed per-handler
  app.post('/v1/things', async () => (await handler()) as any);
  app.put(
    '/v1/things/:id',
    async () =>
      new Response(JSON.stringify({ updated: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        // biome-ignore lint/suspicious/noExplicitAny: same as above
      }) as any,
  );
  app.get('/v1/things/:id', (c) => c.json({ read: true }));
  return app;
}

describe('idempotency middleware', () => {
  beforeEach(async () => {
    await mockRedis.flushall();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('GET requests skip the middleware entirely (no Idempotency-Key required)', async () => {
    const app = makeApp({ clientId: 'c1' });
    const res = await app.request('/v1/things/abc');
    expect(res.status).toBe(200);
  });

  it('POST without Idempotency-Key returns 400', async () => {
    const app = makeApp({ clientId: 'c1' });
    const res = await app.request('/v1/things', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Idempotency-Key/);
  });

  it('POST without clientId on context returns 500 (defense in depth)', async () => {
    // No clientId stubbed → auth context is missing.
    const app = makeApp({});
    const res = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(res.status).toBe(500);
  });

  it('first POST runs handler and returns a normal response (no replay header)', async () => {
    const app = makeApp({ clientId: 'c1' });
    const res = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-idempotent-replay')).toBeNull();
  });

  it('second POST with same key replays cached response (header set)', async () => {
    const calls = vi.fn();
    const app = makeApp({
      clientId: 'c1',
      handler: () => {
        calls();
        return new Response(JSON.stringify({ ok: true, n: calls.mock.calls.length }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    // First request runs the handler.
    const r1 = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    const b1 = (await r1.json()) as { ok: boolean; n: number };
    expect(calls).toHaveBeenCalledTimes(1);
    expect(b1.n).toBe(1);

    // Second request replays — handler MUST NOT run again.
    const r2 = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(calls).toHaveBeenCalledTimes(1); // still 1
    expect(r2.status).toBe(201);
    expect(r2.headers.get('x-idempotent-replay')).toBe('true');
    const b2 = (await r2.json()) as { ok: boolean; n: number };
    expect(b2).toEqual(b1); // byte-identical replay
  });

  it('different keys get independent buckets', async () => {
    const calls = vi.fn();
    const app = makeApp({
      clientId: 'c1',
      handler: () => {
        calls();
        return new Response(JSON.stringify({ n: calls.mock.calls.length }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k2' },
    });
    await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k3' },
    });

    expect(calls).toHaveBeenCalledTimes(3);
  });

  it('different clients get independent buckets (cross-tenant isolation)', async () => {
    // Client c1 POSTs with key k1 → caches response.
    const appA = makeApp({ clientId: 'c1' });
    const r1 = await appA.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(r1.status).toBe(201);

    // Client c2 POSTs with the SAME key — must get a fresh response, NOT
    // client c1's cached one. No cross-tenant leakage.
    const appB = makeApp({ clientId: 'c2' });
    const r2 = await appB.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(r2.status).toBe(201);
    // Critically: no replay header — this was a fresh run.
    expect(r2.headers.get('x-idempotent-replay')).toBeNull();
  });

  it('PUT also gets cached (state-changing method)', async () => {
    const calls = vi.fn();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('clientId', 'c1');
      c.set('apiKeyId', 'k');
      c.set('rateLimit', 100);
      c.set('environment', 'testnet');
      await next();
    });
    app.use('*', idempotency);
    app.put('/v1/things/:id', (c) => {
      calls();
      return c.json({ n: calls.mock.calls.length }, 200);
    });

    await app.request('/v1/things/abc', {
      method: 'PUT',
      headers: { 'idempotency-key': 'k1' },
    });
    await app.request('/v1/things/abc', {
      method: 'PUT',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('5xx responses are NOT cached (transient failures must retry)', async () => {
    const calls = vi.fn();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('clientId', 'c1');
      c.set('apiKeyId', 'k');
      c.set('rateLimit', 100);
      c.set('environment', 'testnet');
      await next();
    });
    app.use('*', idempotency);
    app.post('/v1/things', (c) => {
      calls();
      return c.json({ error: 'transient' }, 503);
    });

    // First request → 503.
    const r1 = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(r1.status).toBe(503);

    // Second request with SAME key → handler runs again because 5xx is
    // not cached. This is the critical behavior: a client retrying after a
    // 503 should get a real retry, not a replayed failure.
    const r2 = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(r2.status).toBe(503);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(r2.headers.get('x-idempotent-replay')).toBeNull();
  });

  it('handler throws: middleware re-throws without caching (task 56)', async () => {
    const calls = vi.fn();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('clientId', 'c1');
      c.set('apiKeyId', 'k');
      c.set('rateLimit', 100);
      c.set('environment', 'testnet');
      await next();
    });
    // Hono onError converts the throw into a 500 at the app level so the
    // request still completes — but the idempotency middleware should NOT
    // have cached anything for this request.
    app.onError((_err, c) => c.json({ error: 'boom' }, 500));
    app.use('*', idempotency);
    app.post('/v1/things', () => {
      calls();
      throw new Error('handler exploded');
    });

    // First request → 500 from onError, NOT cached.
    const r1 = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(r1.status).toBe(500);

    // Second request with the same key → handler runs again because the
    // first attempt was a thrown error, not a deterministic 4xx.
    const r2 = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    expect(r2.status).toBe(500);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(r2.headers.get('x-idempotent-replay')).toBeNull();
  });

  it('4xx responses ARE cached (validation failures are deterministic)', async () => {
    const calls = vi.fn();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('clientId', 'c1');
      c.set('apiKeyId', 'k');
      c.set('rateLimit', 100);
      c.set('environment', 'testnet');
      await next();
    });
    app.use('*', idempotency);
    app.post('/v1/things', (c) => {
      calls();
      return c.json({ error: 'invalid input' }, 400);
    });

    await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    const r2 = await app.request('/v1/things', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    });
    // Handler ran ONCE; the second call was replayed from cache.
    expect(calls).toHaveBeenCalledTimes(1);
    expect(r2.headers.get('x-idempotent-replay')).toBe('true');
  });
});
