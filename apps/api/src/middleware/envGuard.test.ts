import { describe, expect, it, vi } from 'vitest';

// Stub logger to avoid side effects.
vi.mock('../logger.ts', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

// envGuard reads XRPL_NETWORK at module load, so we set it BEFORE import.
process.env.XRPL_NETWORK = 'testnet';

const { envGuard } = await import('./envGuard.ts');

function makeContext(keyEnv: 'testnet' | 'mainnet') {
  const json = vi.fn((_body: unknown, _status: number) => new Response());
  return {
    c: {
      get: vi.fn((key: string) => {
        if (key === 'environment') return keyEnv;
        if (key === 'apiKeyId') return 'key-1';
        return undefined;
      }),
      json,
    } as unknown as Parameters<typeof envGuard>[0],
    next: vi.fn(async () => {}),
    json,
  };
}

describe('envGuard', () => {
  it('passes through when key env matches server network', async () => {
    const { c, next } = makeContext('testnet');
    await envGuard(c, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 403 when key env does not match server network', async () => {
    const { c, next, json } = makeContext('mainnet');
    await envGuard(c, next);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Environment mismatch' }),
      403,
    );
  });
});
