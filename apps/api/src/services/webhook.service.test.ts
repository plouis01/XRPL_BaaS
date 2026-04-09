// Unit tests for webhook.service.ts.
//
// Strategy:
//   - Mock @railforge/db with chainable insert/select/delete builders.
//   - Real node:crypto for the secret generator (we just shape-check it).
//
// What we care about (the things that would actually be bugs):
//   1. Created secret has the right shape AND is returned exactly once.
//   2. listEndpoints excludes the secret column.
//   3. deleteEndpoint scopes by clientId (no cross-tenant deletion).
//   4. URL validation rejects http:// outside localhost (SSRF / plaintext).
//   5. URL validation rejects non-http(s) schemes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbInsertCalls: Array<{ values: unknown }> = [];
const dbInsertResult = { current: [{}] as unknown[] };
const dbSelectResult = { current: [] as unknown[] };
const dbDeleteResult = { current: [] as unknown[] };
const eqArgsLog: Array<{ col: unknown; val: unknown }> = [];
const andArgsLog: Array<unknown[]> = [];

vi.mock('@railforge/db', () => {
  const insert = vi.fn(() => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ values: v });
        return dbInsertResult.current;
      }),
    })),
  }));
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => dbSelectResult.current),
    })),
  }));
  const del = vi.fn(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => dbDeleteResult.current),
    })),
  }));
  return {
    db: { insert, select, delete: del },
    schema: {
      webhookEndpoints: {
        id: 'id',
        clientId: 'clientId',
        url: 'url',
        secret: 'secret',
        events: 'events',
        isActive: 'isActive',
        createdAt: 'createdAt',
      },
    },
    eq: vi.fn((col: unknown, val: unknown) => {
      eqArgsLog.push({ col, val });
      return { col, val };
    }),
    and: vi.fn((...args: unknown[]) => {
      andArgsLog.push(args);
      return { and: args };
    }),
  };
});

// Import AFTER mocks.
const { createEndpoint, listEndpoints, deleteEndpoint, WebhookServiceError } = await import(
  './webhook.service.ts'
);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createEndpoint', () => {
  beforeEach(() => {
    dbInsertCalls.length = 0;
    eqArgsLog.length = 0;
    dbInsertResult.current = [
      {
        id: 'wh-uuid-1',
        url: 'https://example.com/hook',
        events: ['transaction.validated'],
        isActive: true,
        createdAt: new Date('2026-04-09T12:00:00Z'),
      },
    ];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: persists endpoint, returns view with secret returned exactly once', async () => {
    const result = await createEndpoint({
      clientId: 'client-1',
      url: 'https://example.com/hook',
      events: ['transaction.validated'],
    });

    // Response shape — secret is here.
    expect(result.id).toBe('wh-uuid-1');
    expect(result.url).toBe('https://example.com/hook');
    expect(result.events).toEqual(['transaction.validated']);
    expect(result.isActive).toBe(true);
    expect(result.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

    // The secret stored in the DB is the SAME secret returned to the client
    // (it's a shared symmetric key — see service file header).
    const inserted = dbInsertCalls[0]?.values as Record<string, unknown>;
    expect(inserted.secret).toBe(result.secret);
    expect(inserted.clientId).toBe('client-1');
    expect(inserted.url).toBe('https://example.com/hook');
    expect(inserted.events).toEqual(['transaction.validated']);
    expect(inserted.isActive).toBe(true);
  });

  it('rejects javascript: URLs (SSRF defense)', async () => {
    const err = await createEndpoint({
      clientId: 'client-1',
      url: 'javascript:alert(1)',
      events: ['transaction.validated'],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookServiceError);
    expect((err as InstanceType<typeof WebhookServiceError>).code).toBe('invalid_url');
    expect(dbInsertCalls).toHaveLength(0);
  });

  it('rejects file:// URLs (SSRF defense)', async () => {
    const err = await createEndpoint({
      clientId: 'client-1',
      url: 'file:///etc/passwd',
      events: ['transaction.validated'],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookServiceError);
    expect((err as InstanceType<typeof WebhookServiceError>).code).toBe('invalid_url');
  });

  it('rejects http:// URLs except on localhost (no plaintext deliveries to public hosts)', async () => {
    const err = await createEndpoint({
      clientId: 'client-1',
      url: 'http://attacker.example/hook',
      events: ['transaction.validated'],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookServiceError);
    expect((err as InstanceType<typeof WebhookServiceError>).code).toBe('invalid_url');
  });

  it('allows http://localhost for dev', async () => {
    await expect(
      createEndpoint({
        clientId: 'client-1',
        url: 'http://localhost:3000/hook',
        events: ['transaction.validated'],
      }),
    ).resolves.toBeDefined();
  });

  it('allows http://127.0.0.1 for dev', async () => {
    await expect(
      createEndpoint({
        clientId: 'client-1',
        url: 'http://127.0.0.1:3000/hook',
        events: ['transaction.validated'],
      }),
    ).resolves.toBeDefined();
  });

  it('rejects malformed URLs', async () => {
    const err = await createEndpoint({
      clientId: 'client-1',
      url: 'not a url at all',
      events: ['transaction.validated'],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookServiceError);
    expect((err as InstanceType<typeof WebhookServiceError>).code).toBe('invalid_url');
  });
});

describe('listEndpoints', () => {
  beforeEach(() => {
    dbSelectResult.current = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns mapped endpoint views (no secret field)', async () => {
    dbSelectResult.current = [
      {
        id: 'wh-1',
        url: 'https://a.example/hook',
        events: ['transaction.validated'],
        isActive: true,
        createdAt: new Date('2026-04-09T12:00:00Z'),
      },
      {
        id: 'wh-2',
        url: 'https://b.example/hook',
        events: ['transaction.validated', 'transaction.failed'],
        isActive: false,
        createdAt: new Date('2026-04-09T12:01:00Z'),
      },
    ];

    const result = await listEndpoints('client-1');
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('wh-1');
    expect(result[1]?.events).toEqual(['transaction.validated', 'transaction.failed']);

    // CRITICAL: serialized output must not contain 'secret' or any whsec_ value.
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/secret/i);
    expect(json).not.toMatch(/whsec_/);
  });

  it('returns empty array for a client with no endpoints', async () => {
    dbSelectResult.current = [];
    const result = await listEndpoints('client-1');
    expect(result).toEqual([]);
  });
});

describe('deleteEndpoint', () => {
  beforeEach(() => {
    eqArgsLog.length = 0;
    andArgsLog.length = 0;
    dbDeleteResult.current = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when a row was actually deleted', async () => {
    dbDeleteResult.current = [{ id: 'wh-1' }];
    const result = await deleteEndpoint('client-1', 'wh-1');
    expect(result).toBe(true);
  });

  it('returns false when no row matched (unknown id OR wrong client)', async () => {
    dbDeleteResult.current = [];
    const result = await deleteEndpoint('client-1', 'wh-1');
    expect(result).toBe(false);
  });

  it('scopes the WHERE by both id AND clientId (cross-tenant isolation)', async () => {
    dbDeleteResult.current = [];
    await deleteEndpoint('client-1', 'wh-1');

    // The eq() helper was called with both clientId and id.
    const idCall = eqArgsLog.find((c) => c.val === 'wh-1');
    const clientCall = eqArgsLog.find((c) => c.val === 'client-1');
    expect(idCall, 'WHERE missing endpoint id predicate').toBeDefined();
    expect(clientCall, 'WHERE missing clientId predicate').toBeDefined();
    // and() was called to combine them — proves both predicates were chained.
    expect(andArgsLog.length).toBeGreaterThan(0);
  });
});
