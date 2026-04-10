import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Webhooks } from './webhooks.ts';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => null),
  };
}

describe('Webhooks resource', () => {
  let http: ReturnType<typeof mockHttp>;
  let webhooks: Webhooks;

  beforeEach(() => {
    http = mockHttp();
    webhooks = new Webhooks(http as never);
  });

  it('create calls POST /v1/webhooks/endpoints', async () => {
    const params = {
      url: 'https://example.com/hook',
      events: ['transaction.validated' as const],
    };
    await webhooks.create(params);
    expect(http.post).toHaveBeenCalledWith('/v1/webhooks/endpoints', params, undefined);
  });

  it('create forwards idempotencyKey', async () => {
    const params = {
      url: 'https://example.com/hook',
      events: ['transaction.validated' as const],
    };
    await webhooks.create(params, { idempotencyKey: 'wh-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/webhooks/endpoints', params, 'wh-1');
  });

  it('list calls GET /v1/webhooks/endpoints', async () => {
    await webhooks.list();
    expect(http.get).toHaveBeenCalledWith('/v1/webhooks/endpoints');
  });

  it('delete calls DELETE /v1/webhooks/endpoints/:id', async () => {
    await webhooks.delete('ep-1');
    expect(http.delete).toHaveBeenCalledWith('/v1/webhooks/endpoints/ep-1', undefined, undefined);
  });

  it('delete forwards idempotencyKey', async () => {
    await webhooks.delete('ep-1', { idempotencyKey: 'del-1' });
    expect(http.delete).toHaveBeenCalledWith('/v1/webhooks/endpoints/ep-1', undefined, 'del-1');
  });
});
