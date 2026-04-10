import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dex } from './dex.ts';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => null),
  };
}

describe('Dex resource', () => {
  let http: ReturnType<typeof mockHttp>;
  let dex: Dex;

  beforeEach(() => {
    http = mockHttp();
    dex = new Dex(http as never);
  });

  it('createOffer calls POST /v1/dex/offers', async () => {
    const params = {
      account: 'rAcc',
      taker_gets: { drops: '1000000' },
      taker_pays: { currency: 'USD', issuer: 'rIss', value: '10' },
    };
    await dex.createOffer(params);
    expect(http.post).toHaveBeenCalledWith('/v1/dex/offers', params, undefined);
  });

  it('createOffer forwards idempotencyKey', async () => {
    const params = {
      account: 'rAcc',
      taker_gets: { drops: '1000000' },
      taker_pays: { currency: 'USD', issuer: 'rIss', value: '10' },
    };
    await dex.createOffer(params, { idempotencyKey: 'ik-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/dex/offers', params, 'ik-1');
  });

  it('cancelOffer calls DELETE /v1/dex/offers/:id', async () => {
    const params = { account: 'rAcc', offer_sequence: 42 };
    await dex.cancelOffer('42', params);
    expect(http.delete).toHaveBeenCalledWith('/v1/dex/offers/42', params, undefined);
  });

  it('ammDeposit calls POST /v1/dex/amm/deposit', async () => {
    const params = {
      account: 'rAcc',
      asset: { drops: true as const },
      asset2: { currency: 'USD', issuer: 'rIss' },
    };
    await dex.ammDeposit(params);
    expect(http.post).toHaveBeenCalledWith('/v1/dex/amm/deposit', params, undefined);
  });

  it('ammWithdraw calls POST /v1/dex/amm/withdraw', async () => {
    const params = {
      account: 'rAcc',
      asset: { drops: true as const },
      asset2: { currency: 'USD', issuer: 'rIss' },
    };
    await dex.ammWithdraw(params);
    expect(http.post).toHaveBeenCalledWith('/v1/dex/amm/withdraw', params, undefined);
  });
});
