import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agents } from './agents.ts';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  };
}

describe('Agents resource', () => {
  let http: ReturnType<typeof mockHttp>;
  let agents: Agents;

  beforeEach(() => {
    http = mockHttp();
    agents = new Agents(http as never);
  });

  it('provision calls POST /v1/agents', async () => {
    const params = {
      preset: 'payment-agent' as const,
      parent_address: 'rParent...',
      allowlist: [{ entry_type: 'destination' as const, entry_value: 'rDest...' }],
    };
    await agents.provision(params);
    expect(http.post).toHaveBeenCalledWith('/v1/agents', params, undefined);
  });

  it('provision forwards idempotencyKey', async () => {
    const params = {
      preset: 'treasury-agent' as const,
      parent_address: 'rParent...',
    };
    await agents.provision(params, { idempotencyKey: 'agent-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/agents', params, 'agent-1');
  });

  it('list calls GET /v1/agents', async () => {
    await agents.list();
    expect(http.get).toHaveBeenCalledWith('/v1/agents');
  });

  it('get calls GET /v1/agents/:id', async () => {
    await agents.get('agent-uuid-1');
    expect(http.get).toHaveBeenCalledWith('/v1/agents/agent-uuid-1');
  });

  it('revoke calls DELETE /v1/agents/:id with no body', async () => {
    await agents.revoke('agent-uuid-1');
    expect(http.delete).toHaveBeenCalledWith('/v1/agents/agent-uuid-1', undefined, undefined);
  });

  it('revoke forwards idempotencyKey', async () => {
    await agents.revoke('agent-uuid-1', { idempotencyKey: 'rev-1' });
    expect(http.delete).toHaveBeenCalledWith('/v1/agents/agent-uuid-1', undefined, 'rev-1');
  });

  it('updateAllowlist calls PUT /v1/agents/:id/allowlist with the wrapped body', async () => {
    const allowlist = [
      { entry_type: 'destination' as const, entry_value: 'rDest1...' },
      { entry_type: 'destination' as const, entry_value: 'rDest2...' },
    ];
    await agents.updateAllowlist('agent-uuid-1', allowlist);
    expect(http.put).toHaveBeenCalledWith('/v1/agents/agent-uuid-1/allowlist', {
      allowlist,
    });
  });

  it('updateAllowlist accepts an empty array (treasury-agent / refresh)', async () => {
    await agents.updateAllowlist('agent-uuid-1', []);
    expect(http.put).toHaveBeenCalledWith('/v1/agents/agent-uuid-1/allowlist', {
      allowlist: [],
    });
  });
});
