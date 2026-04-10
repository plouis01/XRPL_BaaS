import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Accounts } from './accounts.ts';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  };
}

describe('Accounts resource', () => {
  let http: ReturnType<typeof mockHttp>;
  let accounts: Accounts;

  beforeEach(() => {
    http = mockHttp();
    accounts = new Accounts(http as never);
  });

  it('create calls POST /v1/accounts', async () => {
    await accounts.create({ label: 'test' });
    expect(http.post).toHaveBeenCalledWith('/v1/accounts', { label: 'test' }, undefined);
  });

  it('create forwards idempotencyKey', async () => {
    await accounts.create({}, { idempotencyKey: 'key-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/accounts', {}, 'key-1');
  });

  it('get calls GET /v1/accounts/:address', async () => {
    await accounts.get('rAddr123');
    expect(http.get).toHaveBeenCalledWith('/v1/accounts/rAddr123');
  });

  it('configureSigners calls PUT /v1/accounts/:address/signers', async () => {
    const params = { quorum: 2, signers: [{ address: 'rS1', weight: 1 }] };
    await accounts.configureSigners('rAddr', params);
    expect(http.put).toHaveBeenCalledWith('/v1/accounts/rAddr/signers', params, undefined);
  });

  it('rotateKey calls POST /v1/accounts/:address/rotate-key', async () => {
    await accounts.rotateKey('rAddr', { regular_key: 'rNew' });
    expect(http.post).toHaveBeenCalledWith(
      '/v1/accounts/rAddr/rotate-key',
      { regular_key: 'rNew' },
      undefined,
    );
  });

  it('delete calls DELETE /v1/accounts/:address with body', async () => {
    const params = { destination: 'rDest' };
    await accounts.delete('rAddr', params, { idempotencyKey: 'del-1' });
    expect(http.delete).toHaveBeenCalledWith('/v1/accounts/rAddr', params, 'del-1');
  });
});
