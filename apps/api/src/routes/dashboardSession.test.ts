// Route-level HTTP tests for POST/DELETE /v1/dashboard/session.
//
// Verifies the HIGH-03 fix end-to-end:
//   1. POST with a valid key → 204 + Set-Cookie with httpOnly + SameSite=Strict.
//   2. POST with an unknown key → 401, no Set-Cookie.
//   3. POST with invalid body → 400.
//   4. DELETE → 204 + Set-Cookie with Max-Age=0 (cookie expired).
//   5. Comma smuggling → 401 before the DB is touched.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const limitMock = vi.fn();
vi.mock('@railforge/db', () => {
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
        keyHash: 'keyHash',
        isActive: 'isActive',
        revokedAt: 'revokedAt',
      },
    },
    and: vi.fn(),
    eq: vi.fn(),
    isNull: vi.fn(),
  };
});

vi.mock('../logger.ts', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    child: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
  },
}));

process.env.API_KEY_SALT = 'test-salt-do-not-use-in-production';
process.env.XRPL_NETWORK = 'testnet';

const { default: sessionRoute } = await import('./dashboardSession.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route('/session', sessionRoute);
  return app;
}

describe('POST /session (login)', () => {
  beforeEach(() => {
    limitMock.mockReset();
  });

  it('returns 204 with an httpOnly SameSite=Strict cookie on valid key', async () => {
    limitMock.mockResolvedValueOnce([{ id: 'key-1' }]);
    const app = makeApp();
    const res = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'rf_test_valid_key' }),
    });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('railforge_session=rf_test_valid_key');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    // Path covers the whole app so the cookie is sent back on every /v1 call.
    expect(setCookie).toContain('Path=/');
  });

  it('returns 401 for an unknown key and does NOT set the cookie', async () => {
    limitMock.mockResolvedValueOnce([]);
    const app = makeApp();
    const res = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'rf_test_unknown_key' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('returns 400 for invalid body (Zod rejection)', async () => {
    const app = makeApp();
    const res = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'x' }), // too short
    });
    expect(res.status).toBe(400);
    expect(limitMock).not.toHaveBeenCalled();
  });

  it('rejects comma-smuggled keys before the DB is touched', async () => {
    const app = makeApp();
    const res = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'rf_test_a,rf_test_b' }),
    });
    expect(res.status).toBe(401);
    expect(limitMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /session (logout)', () => {
  it('returns 204 with a cookie-clearing Set-Cookie', async () => {
    const app = makeApp();
    const res = await app.request('/session', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('railforge_session=');
    // deleteCookie sets Max-Age=0 (or an expired date) to clear the cookie.
    expect(setCookie).toMatch(/(Max-Age=0|Expires=Thu, 01 Jan 1970)/);
  });
});
