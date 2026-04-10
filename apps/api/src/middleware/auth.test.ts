// Tests for the API key auth middleware. This is the SOLE authentication
// barrier on the API — every test here is load-bearing for security.
//
// Strategy: mock @railforge/db so we don't need a live Postgres. The query
// builder chain returns a fake `limit()` whose result we control per test.
//
// API_KEY_SALT is set in beforeAll because the auth middleware HMACs the raw
// key with the salt as the pepper. A missing salt makes hashApiKey throw —
// covered as its own test below.

import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

// ── Mock the DB module BEFORE importing auth.ts ─────────────────────────────
const limitMock = vi.fn();
vi.mock('@railforge/db', () => {
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
        id: 'id',
        clientId: 'clientId',
        environment: 'environment',
        rateLimit: 'rateLimit',
        isActive: 'isActive',
        keyHash: 'keyHash',
        revokedAt: 'revokedAt',
      },
    },
    and: vi.fn(),
    eq: vi.fn(),
    isNull: vi.fn(),
  };
});

// Set the salt BEFORE importing auth.ts — hashApiKey reads it lazily on each
// call but tests still want a deterministic value.
process.env.API_KEY_SALT = 'test-salt-do-not-use-in-production';

// Import auth AFTER the mock and env var are set.
const { auth, hashApiKey } = await import('./auth.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', auth);
  app.get('/protected', (c) => {
    return c.json({
      clientId: c.get('clientId'),
      apiKeyId: c.get('apiKeyId'),
      rateLimit: c.get('rateLimit'),
      environment: c.get('environment'),
    });
  });
  return app;
}

// Active row template — note `isActive` is intentionally NOT in the result
// because the WHERE clause filters it. The query only selects id/clientId/
// environment/rateLimit.
function activeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'key-id-1',
    clientId: 'client-id-1',
    environment: 'testnet',
    rateLimit: 100,
    ...overrides,
  };
}

describe('auth middleware', () => {
  beforeAll(() => {
    if (!process.env.API_KEY_SALT) {
      throw new Error('test setup error: API_KEY_SALT not set');
    }
  });

  beforeEach(() => {
    limitMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests with no X-API-Key header', async () => {
    const app = makeApp();
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Missing API key' });
    // Crucially: we never queried the database for this case.
    expect(limitMock).not.toHaveBeenCalled();
  });

  it('returns identical 401 for unknown, inactive, and revoked keys (no enumeration oracle)', async () => {
    // After moving isActive into SQL WHERE, all three rejection classes
    // collapse into "no matching row" — there is now exactly ONE rejection
    // code path. We verify that property here.
    const app = makeApp();

    limitMock.mockResolvedValueOnce([]); // case A: hash doesn't match anything
    const a = await app.request('/protected', {
      headers: { 'x-api-key': 'rf_test_unknown' },
    });

    limitMock.mockResolvedValueOnce([]); // case B: row exists but isActive=false → SQL excludes it
    const b = await app.request('/protected', {
      headers: { 'x-api-key': 'rf_test_inactive' },
    });

    limitMock.mockResolvedValueOnce([]); // case C: row exists but revokedAt set → SQL excludes it
    const c = await app.request('/protected', {
      headers: { 'x-api-key': 'rf_test_revoked' },
    });

    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(c.status).toBe(401);
    const [bodyA, bodyB, bodyC] = await Promise.all([a.json(), b.json(), c.json()]);
    expect(bodyA).toEqual({ error: 'Invalid API key' });
    expect(bodyA).toEqual(bodyB);
    expect(bodyB).toEqual(bodyC);
  });

  it('passes through and stashes context for an active testnet key', async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([
      activeRow({
        id: 'key-id-1',
        clientId: 'client-id-1',
        environment: 'testnet',
        rateLimit: 250,
      }),
    ]);

    const res = await app.request('/protected', {
      headers: { 'x-api-key': 'rf_test_valid' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      clientId: 'client-id-1',
      apiKeyId: 'key-id-1',
      rateLimit: 250,
      environment: 'testnet',
    });
  });

  it('coerces an unknown environment string to testnet (mainnet must be exact)', async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([activeRow({ environment: 'devnet' })]);

    const res = await app.request('/protected', {
      headers: { 'x-api-key': 'rf_d_x' },
    });
    const body = (await res.json()) as { environment: string };
    expect(body.environment).toBe('testnet'); // safe fallback
  });

  it('routes a row with environment="mainnet" to mainnet', async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([activeRow({ environment: 'mainnet' })]);

    const res = await app.request('/protected', {
      headers: { 'x-api-key': 'rf_live_x' },
    });
    const body = (await res.json()) as { environment: string };
    expect(body.environment).toBe('mainnet');
  });

  it('exposes the X-RailForge-Key-Prefix header on success but never the full key', async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([activeRow()]);

    const apiKey = 'rf_test_abcdefghijklmnop';
    const res = await app.request('/protected', {
      headers: { 'x-api-key': apiKey },
    });
    const prefix = res.headers.get('x-railforge-key-prefix');
    expect(prefix).toBe('rf_test_'); // first 8 chars only
    expect(prefix).not.toBe(apiKey);
  });

  it('does not include the key prefix on rejected requests (avoid confirming format)', async () => {
    const app = makeApp();
    limitMock.mockResolvedValueOnce([]);
    const res = await app.request('/protected', {
      headers: { 'x-api-key': 'wrong' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-railforge-key-prefix')).toBeNull();
  });

  it('rejects keys with commas (header smuggling defense)', async () => {
    const app = makeApp();
    const res = await app.request('/protected', {
      headers: { 'x-api-key': 'rf_test_a,rf_test_b' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid API key' });
    expect(limitMock).not.toHaveBeenCalled();
  });

  it('returns 503 when the DB query fails (fail closed)', async () => {
    const app = makeApp();
    limitMock.mockRejectedValueOnce(new Error('connection refused'));

    const res = await app.request('/protected', {
      headers: { 'x-api-key': 'rf_test_valid' },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'Service unavailable' });
  });

  it('issues a database query for every distinct key (no in-process key cache)', async () => {
    const app = makeApp();
    limitMock.mockResolvedValue([]);

    await app.request('/protected', { headers: { 'x-api-key': 'a' } });
    await app.request('/protected', { headers: { 'x-api-key': 'b' } });
    await app.request('/protected', { headers: { 'x-api-key': 'a' } });

    // No caching — three lookups for three requests, even though 'a' was
    // seen twice. Caching would mean a revoked key keeps working until the
    // cache TTL expires.
    expect(limitMock).toHaveBeenCalledTimes(3);
  });
});

describe('hashApiKey (HMAC pepper)', () => {
  it('produces a 64-char hex string', () => {
    const hash = hashApiKey('rf_test_anything');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same input under the same salt', () => {
    expect(hashApiKey('rf_test_xyz')).toBe(hashApiKey('rf_test_xyz'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashApiKey('rf_test_a')).not.toBe(hashApiKey('rf_test_b'));
  });

  it('produces different hashes when the salt changes (pepper actually applied)', () => {
    const original = process.env.API_KEY_SALT;
    const h1 = hashApiKey('rf_test_same');
    process.env.API_KEY_SALT = 'a-different-salt';
    const h2 = hashApiKey('rf_test_same');
    process.env.API_KEY_SALT = original;
    expect(h1).not.toBe(h2);
  });

  it('throws if API_KEY_SALT is unset (fail-fast at first auth call)', () => {
    const original = process.env.API_KEY_SALT;
    // `delete` is the only way to actually remove the env var. Assigning
    // `undefined` would set it to the string "undefined", which would silently
    // pass the truthiness check inside hashApiKey and mask the real bug.
    // biome-ignore lint/performance/noDelete: env var must be removed, not set to "undefined"
    delete process.env.API_KEY_SALT;
    expect(() => hashApiKey('rf_test_anything')).toThrow(/API_KEY_SALT/);
    process.env.API_KEY_SALT = original;
  });
});
