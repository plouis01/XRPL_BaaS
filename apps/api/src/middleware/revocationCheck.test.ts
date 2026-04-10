import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbSelectResult = { current: [] as unknown[] };

vi.mock('@railforge/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => dbSelectResult.current),
        })),
      })),
    })),
  },
  schema: {
    apiKeys: { id: 'id', isActive: 'is_active', revokedAt: 'revoked_at' },
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

const { revocationCheck } = await import('./revocationCheck.ts');

function makeContext() {
  const json = vi.fn((_body: unknown, _status: number) => new Response());
  return {
    c: {
      get: vi.fn((key: string) => {
        if (key === 'apiKeyId') return 'key-123';
        return undefined;
      }),
      json,
    } as unknown as Parameters<typeof revocationCheck>[0],
    next: vi.fn(async () => {}),
    json,
  };
}

describe('revocationCheck', () => {
  beforeEach(() => {
    dbSelectResult.current = [];
  });

  it('passes through when key is still active', async () => {
    dbSelectResult.current = [{ id: 'key-123' }];
    const { c, next } = makeContext();
    await revocationCheck(c, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 401 when key has been revoked (no matching row)', async () => {
    dbSelectResult.current = [];
    const { c, next, json } = makeContext();
    await revocationCheck(c, next);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ error: 'API key has been revoked' }, 401);
  });
});
