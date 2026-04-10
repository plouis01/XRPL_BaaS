import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Domains } from './domains.ts';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => null),
  };
}

describe('Domains resource', () => {
  let http: ReturnType<typeof mockHttp>;
  let domains: Domains;

  beforeEach(() => {
    http = mockHttp();
    domains = new Domains(http as never);
  });

  it('create calls POST /v1/domains', async () => {
    const params = {
      owner_address: 'rOwner',
      accepted_credentials: [{ issuer: 'rIss', credential_type: '4B5943' }],
    };
    await domains.create(params);
    expect(http.post).toHaveBeenCalledWith('/v1/domains', params, undefined);
  });

  it('create forwards idempotencyKey', async () => {
    const params = {
      owner_address: 'rOwner',
      accepted_credentials: [{ issuer: 'rIss', credential_type: '4B5943' }],
    };
    await domains.create(params, { idempotencyKey: 'dk-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/domains', params, 'dk-1');
  });

  it('get calls GET /v1/domains/:id', async () => {
    await domains.get('dom-1');
    expect(http.get).toHaveBeenCalledWith('/v1/domains/dom-1');
  });

  it('update calls PUT /v1/domains/:id', async () => {
    const params = {
      accepted_credentials: [{ issuer: 'rIss', credential_type: '4B5943' }],
    };
    await domains.update('dom-1', params);
    expect(http.put).toHaveBeenCalledWith('/v1/domains/dom-1', params, undefined);
  });

  it('delete calls DELETE /v1/domains/:id', async () => {
    await domains.delete('dom-1');
    expect(http.delete).toHaveBeenCalledWith('/v1/domains/dom-1', undefined, undefined);
  });

  it('listMembers calls GET /v1/domains/:id/members', async () => {
    await domains.listMembers('dom-1');
    expect(http.get).toHaveBeenCalledWith('/v1/domains/dom-1/members');
  });

  it('checkMembership calls POST /v1/domains/:id/check', async () => {
    await domains.checkMembership('dom-1', { subject_address: 'rSub' });
    expect(http.post).toHaveBeenCalledWith('/v1/domains/dom-1/check', {
      subject_address: 'rSub',
    });
  });
});
