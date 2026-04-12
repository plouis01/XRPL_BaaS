// Route-level HTTP tests for /v1/domains (Sprint 7).

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const VALID_ADDR = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

const mockCreateDomain = vi.fn();
const mockGetDomain = vi.fn();
const mockUpdateDomain = vi.fn();
const mockDeleteDomain = vi.fn();
const mockListMembers = vi.fn();
const mockCheckMembership = vi.fn();

vi.mock('../services/domain.service.ts', () => ({
  createDomain: (...args: unknown[]) => mockCreateDomain(...args),
  getDomain: (...args: unknown[]) => mockGetDomain(...args),
  updateDomain: (...args: unknown[]) => mockUpdateDomain(...args),
  deleteDomain: (...args: unknown[]) => mockDeleteDomain(...args),
  listMembers: (...args: unknown[]) => mockListMembers(...args),
  checkMembership: (...args: unknown[]) => mockCheckMembership(...args),
  DomainServiceError: class DomainServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'DomainServiceError';
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

const { default: domainsRoute } = await import('./domains.ts');
const { DomainServiceError } = await import('../services/domain.service.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    await next();
  });
  app.route('/domains', domainsRoute);
  return app;
}

describe('POST /domains', () => {
  beforeEach(() => vi.clearAllMocks());

  it('201 on success', async () => {
    mockCreateDomain.mockResolvedValue({
      id: 'dom-1',
      domainId: 'ABC',
      status: 'queued',
    });
    const app = makeApp();
    const res = await app.request('/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner_address: VALID_ADDR,
        accepted_credentials: [{ issuer: VALID_ADDR, credential_type: 'AABB' }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.domainId).toBe('ABC');
  });

  it('400 when owner not managed', async () => {
    mockCreateDomain.mockRejectedValue(new DomainServiceError('not_managed', 'not managed'));
    const app = makeApp();
    const res = await app.request('/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner_address: VALID_ADDR,
        accepted_credentials: [{ issuer: VALID_ADDR, credential_type: 'AABB' }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /domains/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 with domain data', async () => {
    mockGetDomain.mockResolvedValue({ id: 'dom-1', domainId: 'ABC' });
    const app = makeApp();
    const res = await app.request('/domains/dom-1');
    expect(res.status).toBe(200);
  });

  it('404 when not found', async () => {
    mockGetDomain.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/domains/dom-missing');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /domains/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('202 on success', async () => {
    mockDeleteDomain.mockResolvedValue({ txId: 'tx-del' });
    const app = makeApp();
    const res = await app.request('/domains/dom-1', { method: 'DELETE' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('queued');
  });
});

describe('GET /domains/:id/members', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 with members', async () => {
    mockListMembers.mockResolvedValue({ data: [], total: 0 });
    const app = makeApp();
    const res = await app.request('/domains/dom-1/members');
    expect(res.status).toBe(200);
  });

  it('400 on invalid limit', async () => {
    const app = makeApp();
    const res = await app.request('/domains/dom-1/members?limit=0');
    expect(res.status).toBe(400);
  });

  it('400 on negative offset', async () => {
    const app = makeApp();
    const res = await app.request('/domains/dom-1/members?offset=-1');
    expect(res.status).toBe(400);
  });
});

describe('POST /domains/:id/check', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 on success', async () => {
    mockCheckMembership.mockResolvedValue({ isMember: true });
    const app = makeApp();
    const res = await app.request('/domains/dom-1/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_address: VALID_ADDR }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.isMember).toBe(true);
  });
});
