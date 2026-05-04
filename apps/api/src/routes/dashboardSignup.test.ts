// Route-level HTTP tests for POST /v1/dashboard/signup.
//
// The endpoint is dev-only (gated in apps/api/src/index.ts on NODE_ENV !==
// 'production'). These tests verify the route's own behavior:
//   1. valid body → 201 + { api_key starting with rf_test_, client_id }
//   2. invalid body → 400 (Zod rejection, no DB write)
//   3. existing email → reuses the client row (no duplicate insert)
//   4. DB failure → 503 (matches the session route's fail-closed posture)

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const selectLimitMock = vi.fn();
const insertReturningMock = vi.fn();
const insertValuesMock = vi.fn();

vi.mock('@railforge/db', () => {
  const selectChain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: (n: number) => selectLimitMock(n),
  };
  // Insert chain. `values()` returns an awaitable Promise that ALSO exposes
  // `.returning()` for the clients insert. The api_keys insert just awaits
  // the Promise directly. Wrapping a Promise dodges biome's noThenProperty
  // rule (which fires on plain objects exposing a `then` key).
  const insertChain = {
    insert: vi.fn().mockReturnThis(),
    values: (vals: unknown) => {
      insertValuesMock(vals);
      const promise = Promise.resolve(undefined) as Promise<undefined> & {
        returning: () => Promise<Array<{ id: string }>>;
      };
      promise.returning = () => insertReturningMock();
      return promise;
    },
  };
  return {
    db: { ...selectChain, ...insertChain },
    schema: {
      clients: { id: 'id', email: 'email', name: 'name', plan: 'plan' },
      apiKeys: {
        id: 'id',
        clientId: 'clientId',
        keyHash: 'keyHash',
        keyPrefix: 'keyPrefix',
        label: 'label',
        environment: 'environment',
        rateLimit: 'rateLimit',
        isActive: 'isActive',
      },
    },
    eq: vi.fn(),
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

const { default: signupRoute } = await import('./dashboardSignup.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route('/signup', signupRoute);
  return app;
}

describe('POST /signup (dev signup)', () => {
  beforeEach(() => {
    selectLimitMock.mockReset();
    insertReturningMock.mockReset();
    insertValuesMock.mockReset();
  });

  it('returns 201 with a fresh rf_test_ key for a new email', async () => {
    selectLimitMock.mockResolvedValueOnce([]); // no existing client
    insertReturningMock.mockResolvedValueOnce([{ id: 'client-new' }]); // clients insert
    const app = makeApp();
    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@dev.local', name: 'Dev User' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      api_key: string;
      client_id: string;
      environment: string;
    };
    expect(body.api_key).toMatch(/^rf_test_[A-Za-z0-9_-]+$/);
    expect(body.client_id).toBe('client-new');
    expect(body.environment).toBe('testnet');
    // Two inserts: clients row, then apiKeys row.
    expect(insertValuesMock).toHaveBeenCalledTimes(2);
    const apiKeyInsertArgs = insertValuesMock.mock.calls[1]![0] as {
      clientId: string;
      environment: string;
      isActive: boolean;
    };
    expect(apiKeyInsertArgs.clientId).toBe('client-new');
    expect(apiKeyInsertArgs.environment).toBe('testnet');
    expect(apiKeyInsertArgs.isActive).toBe(true);
  });

  it('reuses the existing client row when the email is known', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'client-existing' }]);
    const app = makeApp();
    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'known@dev.local', name: 'Dev User' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    expect(body.client_id).toBe('client-existing');
    // Only one insert (the api_keys one) — no clients insert when reusing.
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertReturningMock).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid body and never touches the DB', async () => {
    const app = makeApp();
    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', name: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(selectLimitMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('returns 503 when the DB write fails', async () => {
    selectLimitMock.mockRejectedValueOnce(new Error('connection refused'));
    const app = makeApp();
    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@dev.local', name: 'Dev User' }),
    });
    expect(res.status).toBe(503);
  });
});
