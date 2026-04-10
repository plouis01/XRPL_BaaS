import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertCalls: unknown[] = [];
let insertShouldReject = false;

vi.mock('@railforge/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        insertCalls.push(v);
        if (insertShouldReject) return Promise.reject(new Error('DB down'));
        return Promise.resolve();
      }),
    })),
  },
  schema: { auditLog: { __name: 'audit_log' } },
}));

vi.mock('../logger.ts', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { auditLog } = await import('./auditLog.ts');

function makeContext(method: string, statusCode: number) {
  return {
    c: {
      req: {
        method,
        path: '/v1/accounts',
        header: vi.fn(() => null),
        raw: { clone: () => ({ text: async () => '{"label":"test"}' }) },
      },
      res: { status: statusCode },
      get: vi.fn((key: string) => {
        if (key === 'clientId') return 'client-1';
        if (key === 'apiKeyId') return 'key-1';
        return undefined;
      }),
    } as unknown as Parameters<typeof auditLog>[0],
    next: vi.fn(async () => {}),
  };
}

describe('auditLog', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    insertShouldReject = false;
  });

  it('inserts an audit row for POST requests', async () => {
    const { c, next } = makeContext('POST', 201);
    await auditLog(c, next);
    expect(next).toHaveBeenCalledOnce();
    // fire-and-forget — give the promise a tick to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(insertCalls).toHaveLength(1);
    const row = insertCalls[0] as Record<string, unknown>;
    expect(row.clientId).toBe('client-1');
    expect(row.method).toBe('POST');
    expect(row.statusCode).toBe(201);
  });

  it('skips GET requests', async () => {
    const { c, next } = makeContext('GET', 200);
    await auditLog(c, next);
    expect(next).toHaveBeenCalledOnce();
    await new Promise((r) => setTimeout(r, 10));
    expect(insertCalls).toHaveLength(0);
  });

  it('does not block the response when DB insert fails', async () => {
    insertShouldReject = true;
    const { c, next } = makeContext('DELETE', 200);
    // Should not throw even though DB is down.
    await auditLog(c, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('skips when clientId is missing (unauthenticated)', async () => {
    const { c, next } = makeContext('POST', 401);
    (c.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    await auditLog(c, next);
    await new Promise((r) => setTimeout(r, 10));
    expect(insertCalls).toHaveLength(0);
  });
});
