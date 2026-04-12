// Route-level HTTP tests for /v1/permissions (Sprint 7).

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const VALID_DELEGATOR = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const VALID_DELEGATE = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

const mockGrantPermission = vi.fn();
const mockListDelegations = vi.fn();
const mockGetDelegationAudit = vi.fn();
const mockRevokePermission = vi.fn();

vi.mock('../services/permission.service.ts', () => ({
  grantPermission: (...args: unknown[]) => mockGrantPermission(...args),
  listDelegations: (...args: unknown[]) => mockListDelegations(...args),
  getDelegationAudit: (...args: unknown[]) => mockGetDelegationAudit(...args),
  revokePermission: (...args: unknown[]) => mockRevokePermission(...args),
  PermissionServiceError: class PermissionServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'PermissionServiceError';
    }
  },
}));

vi.mock('../middleware/revocationCheck.ts', () => ({
  revocationCheck: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('@railforge/db', () => ({
  db: {},
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  schema: { apiKeys: {} },
}));

const { default: permissionsRoute } = await import('./permissions.ts');
const { PermissionServiceError } = await import('../services/permission.service.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    await next();
  });
  app.route('/permissions', permissionsRoute);
  return app;
}

describe('POST /permissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('201 on success', async () => {
    mockGrantPermission.mockResolvedValue({ id: 'del-1', txId: 'tx-1' });
    const app = makeApp();
    const res = await app.request('/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delegator_address: VALID_DELEGATOR,
        delegate_address: VALID_DELEGATE,
        permissions: ['Payment'],
      }),
    });
    expect(res.status).toBe(201);
  });

  it('409 when delegation already exists', async () => {
    mockGrantPermission.mockRejectedValue(
      new PermissionServiceError('already_exists', 'already exists'),
    );
    const app = makeApp();
    const res = await app.request('/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delegator_address: VALID_DELEGATOR,
        delegate_address: VALID_DELEGATE,
        permissions: ['Payment'],
      }),
    });
    expect(res.status).toBe(409);
  });

  it('400 on invalid permission value', async () => {
    const app = makeApp();
    const res = await app.request('/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delegator_address: VALID_DELEGATOR,
        delegate_address: VALID_DELEGATE,
        permissions: ['BogusPermission'],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /permissions/:delegator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 with list of delegations', async () => {
    mockListDelegations.mockResolvedValue([{ id: 'del-1' }]);
    const app = makeApp();
    const res = await app.request(`/permissions/${VALID_DELEGATOR}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.data).toHaveLength(1);
  });
});

describe('GET /permissions/audit/:delegator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 with audit data', async () => {
    mockGetDelegationAudit.mockResolvedValue([{ id: 'log-1' }]);
    const app = makeApp();
    const res = await app.request(`/permissions/audit/${VALID_DELEGATOR}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.data).toHaveLength(1);
  });
});

describe('DELETE /permissions/:delegator/:delegate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('202 on success', async () => {
    mockRevokePermission.mockResolvedValue({ txId: 'tx-rev' });
    const app = makeApp();
    const res = await app.request(`/permissions/${VALID_DELEGATOR}/${VALID_DELEGATE}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delegator_address: VALID_DELEGATOR }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('queued');
  });

  it('400 when body delegator_address mismatches URL', async () => {
    const app = makeApp();
    const res = await app.request(`/permissions/${VALID_DELEGATOR}/${VALID_DELEGATE}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delegator_address: VALID_DELEGATE }),
    });
    expect(res.status).toBe(400);
  });
});
