import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Permissions } from './permissions.ts';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => null),
  };
}

describe('Permissions resource', () => {
  let http: ReturnType<typeof mockHttp>;
  let permissions: Permissions;

  beforeEach(() => {
    http = mockHttp();
    permissions = new Permissions(http as never);
  });

  it('grant calls POST /v1/permissions', async () => {
    const params = {
      delegator_address: 'rDel',
      delegate_address: 'rDlg',
      permissions: ['Payment' as const],
    };
    await permissions.grant(params);
    expect(http.post).toHaveBeenCalledWith('/v1/permissions', params, undefined);
  });

  it('grant forwards idempotencyKey', async () => {
    const params = {
      delegator_address: 'rDel',
      delegate_address: 'rDlg',
      permissions: ['Payment' as const],
    };
    await permissions.grant(params, { idempotencyKey: 'ik-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/permissions', params, 'ik-1');
  });

  it('list calls GET /v1/permissions/:delegator', async () => {
    await permissions.list('rDel');
    expect(http.get).toHaveBeenCalledWith('/v1/permissions/rDel');
  });

  it('revoke calls DELETE /v1/permissions/:delegator/:delegate', async () => {
    const params = { delegator_address: 'rDel' };
    await permissions.revoke('rDel', 'rDlg', params);
    expect(http.delete).toHaveBeenCalledWith('/v1/permissions/rDel/rDlg', params, undefined);
  });

  it('audit calls GET /v1/permissions/audit/:delegator', async () => {
    await permissions.audit('rDel');
    expect(http.get).toHaveBeenCalledWith('/v1/permissions/audit/rDel');
  });
});
