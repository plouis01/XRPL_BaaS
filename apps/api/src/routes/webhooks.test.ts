// Route-level HTTP tests for /v1/webhooks (Sprint 7).

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.ts';

const mockCreateEndpoint = vi.fn();
const mockListEndpoints = vi.fn();
const mockDeleteEndpoint = vi.fn();

vi.mock('../services/webhook.service.ts', () => ({
  createEndpoint: (...args: unknown[]) => mockCreateEndpoint(...args),
  listEndpoints: (...args: unknown[]) => mockListEndpoints(...args),
  deleteEndpoint: (...args: unknown[]) => mockDeleteEndpoint(...args),
  WebhookServiceError: class WebhookServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'WebhookServiceError';
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

const { default: webhooksRoute } = await import('./webhooks.ts');
const { WebhookServiceError } = await import('../services/webhook.service.ts');

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('clientId', 'client-1');
    c.set('apiKeyId', 'key-1');
    c.set('rateLimit', 100);
    c.set('environment', 'testnet');
    await next();
  });
  app.route('/webhooks', webhooksRoute);
  return app;
}

describe('POST /webhooks/endpoints', () => {
  beforeEach(() => vi.clearAllMocks());

  it('201 on success with secret in response', async () => {
    mockCreateEndpoint.mockResolvedValue({
      id: 'ep-1',
      url: 'https://example.com/hook',
      events: ['transaction.validated'],
      isActive: true,
      secret: 'whsec_abc123',
      createdAt: new Date('2026-01-01'),
    });

    const app = makeApp();
    const res = await app.request('/webhooks/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/hook',
        events: ['transaction.validated'],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe('ep-1');
    expect(body.secret).toBe('whsec_abc123');
    expect(body.is_active).toBe(true);
  });

  it('400 on invalid URL', async () => {
    mockCreateEndpoint.mockRejectedValue(
      new WebhookServiceError('invalid_url', 'URL contains private IP'),
    );

    const app = makeApp();
    const res = await app.request('/webhooks/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/hook',
        events: ['transaction.validated'],
      }),
    });

    expect(res.status).toBe(400);
  });

  it('400 on Zod validation failure (no events)', async () => {
    const app = makeApp();
    const res = await app.request('/webhooks/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: [] }),
    });

    expect(res.status).toBe(400);
  });

  it('400 on Zod validation failure (invalid event type)', async () => {
    const app = makeApp();
    const res = await app.request('/webhooks/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/hook',
        events: ['bogus.event'],
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /webhooks/endpoints', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 with list of endpoints (no secrets)', async () => {
    mockListEndpoints.mockResolvedValue([
      {
        id: 'ep-1',
        url: 'https://example.com/hook',
        events: ['transaction.validated'],
        isActive: true,
        createdAt: new Date('2026-01-01'),
      },
    ]);

    const app = makeApp();
    const res = await app.request('/webhooks/endpoints');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0]!.id).toBe('ep-1');
    expect(data[0]!).not.toHaveProperty('secret');
  });

  it('200 with empty list', async () => {
    mockListEndpoints.mockResolvedValue([]);

    const app = makeApp();
    const res = await app.request('/webhooks/endpoints');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.data).toEqual([]);
  });
});

describe('DELETE /webhooks/endpoints/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('204 on success', async () => {
    mockDeleteEndpoint.mockResolvedValue(true);

    const app = makeApp();
    const res = await app.request('/webhooks/endpoints/ep-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
  });

  it('404 when endpoint not found', async () => {
    mockDeleteEndpoint.mockResolvedValue(false);

    const app = makeApp();
    const res = await app.request('/webhooks/endpoints/ep-missing', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
  });
});
