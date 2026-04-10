import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Payments } from './payments.ts';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  };
}

describe('Payments resource', () => {
  let http: ReturnType<typeof mockHttp>;
  let payments: Payments;

  beforeEach(() => {
    http = mockHttp();
    payments = new Payments(http as never);
  });

  it('send calls POST /v1/payments', async () => {
    const params = { source: 'rS', destination: 'rD', amount_drops: '1000000' };
    await payments.send(params as never);
    expect(http.post).toHaveBeenCalledWith('/v1/payments', params, undefined);
  });

  it('send forwards idempotencyKey', async () => {
    const params = { source: 'rS', destination: 'rD', amount_drops: '1000000' };
    await payments.send(params as never, { idempotencyKey: 'pay-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/payments', params, 'pay-1');
  });

  it('get calls GET /v1/payments/:id', async () => {
    await payments.get('tx-123');
    expect(http.get).toHaveBeenCalledWith('/v1/payments/tx-123');
  });

  it('createEscrow calls POST /v1/payments/escrows', async () => {
    const params = {
      source: 'rS',
      destination: 'rD',
      amount_drops: '5000000',
      finish_after: 100,
    };
    await payments.createEscrow(params);
    expect(http.post).toHaveBeenCalledWith('/v1/payments/escrows', params, undefined);
  });

  it('finishEscrow calls POST /v1/payments/escrows/:id/finish', async () => {
    const params = { source: 'rS', owner: 'rO', offer_sequence: 42 };
    await payments.finishEscrow('esc-1', params);
    expect(http.post).toHaveBeenCalledWith('/v1/payments/escrows/esc-1/finish', params, undefined);
  });

  it('cancelEscrow calls POST /v1/payments/escrows/:id/cancel', async () => {
    const params = { source: 'rS', owner: 'rO', offer_sequence: 42 };
    await payments.cancelEscrow('esc-1', params, { idempotencyKey: 'c-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/payments/escrows/esc-1/cancel', params, 'c-1');
  });
});
