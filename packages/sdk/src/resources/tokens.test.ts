import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Tokens } from './tokens.ts';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  };
}

describe('Tokens resource', () => {
  let http: ReturnType<typeof mockHttp>;
  let tokens: Tokens;

  beforeEach(() => {
    http = mockHttp();
    tokens = new Tokens(http as never);
  });

  it('create calls POST /v1/tokens', async () => {
    const params = { issuer: 'rIss', currency_code: 'USD' };
    await tokens.create(params);
    expect(http.post).toHaveBeenCalledWith('/v1/tokens', params, undefined);
  });

  it('create forwards idempotencyKey', async () => {
    const params = { issuer: 'rIss', currency_code: 'USD' };
    await tokens.create(params, { idempotencyKey: 'tk-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/tokens', params, 'tk-1');
  });

  it('transfer calls POST /v1/tokens/:id/transfer', async () => {
    await tokens.transfer('t1', { destination: 'rH', amount: '100' });
    expect(http.post).toHaveBeenCalledWith(
      '/v1/tokens/t1/transfer',
      { destination: 'rH', amount: '100' },
      undefined,
    );
  });

  it('freeze calls PUT /v1/tokens/:id/freeze', async () => {
    await tokens.freeze('t1', { unfreeze: true });
    expect(http.put).toHaveBeenCalledWith('/v1/tokens/t1/freeze', { unfreeze: true }, undefined);
  });

  it('clawback calls PUT /v1/tokens/:id/clawback', async () => {
    await tokens.clawback('t1', { holder: 'rH', amount: '50' });
    expect(http.put).toHaveBeenCalledWith(
      '/v1/tokens/t1/clawback',
      { holder: 'rH', amount: '50' },
      undefined,
    );
  });
});
