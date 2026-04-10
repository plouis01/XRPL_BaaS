import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Credentials } from './credentials.ts';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => null),
  };
}

describe('Credentials resource', () => {
  let http: ReturnType<typeof mockHttp>;
  let credentials: Credentials;

  beforeEach(() => {
    http = mockHttp();
    credentials = new Credentials(http as never);
  });

  it('issue calls POST /v1/credentials', async () => {
    const params = {
      issuer_address: 'rIss',
      subject_address: 'rSub',
      credential_type: '4B5943',
    };
    await credentials.issue(params);
    expect(http.post).toHaveBeenCalledWith('/v1/credentials', params, undefined);
  });

  it('issue forwards idempotencyKey', async () => {
    const params = {
      issuer_address: 'rIss',
      subject_address: 'rSub',
      credential_type: '4B5943',
    };
    await credentials.issue(params, { idempotencyKey: 'ik-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/credentials', params, 'ik-1');
  });

  it('get calls GET /v1/credentials/:id', async () => {
    await credentials.get('cred-1');
    expect(http.get).toHaveBeenCalledWith('/v1/credentials/cred-1');
  });

  it('accept calls POST /v1/credentials/:id/accept', async () => {
    await credentials.accept('cred-1', { subject_address: 'rSub' });
    expect(http.post).toHaveBeenCalledWith(
      '/v1/credentials/cred-1/accept',
      { subject_address: 'rSub' },
      undefined,
    );
  });

  it('revoke calls DELETE /v1/credentials/:id', async () => {
    await credentials.revoke('cred-1');
    expect(http.delete).toHaveBeenCalledWith('/v1/credentials/cred-1', undefined, undefined);
  });

  it('verify calls POST /v1/credentials/verify', async () => {
    const params = {
      subject_address: 'rSub',
      issuer_address: 'rIss',
      credential_type: '4B5943',
    };
    await credentials.verify(params);
    expect(http.post).toHaveBeenCalledWith('/v1/credentials/verify', params);
  });

  it('listIssuers calls GET /v1/credentials/issuers', async () => {
    await credentials.listIssuers();
    expect(http.get).toHaveBeenCalledWith('/v1/credentials/issuers');
  });
});
