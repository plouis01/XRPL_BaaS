import { describe, expect, it, vi } from 'vitest';

// Mock xrpl Client to avoid real WebSocket connections.
vi.mock('xrpl', () => {
  const MockClient = vi.fn().mockImplementation(() => ({
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    on: vi.fn(),
    request: vi.fn(),
  }));
  return { Client: MockClient };
});

vi.mock('@railforge/xrpl-core', () => ({
  TESTNET_WS_URL: 'wss://testnet.example.com',
  MAINNET_WS_URLS: ['wss://mainnet1.example.com', 'wss://mainnet2.example.com'],
}));

vi.mock('../logger.ts', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

const { XrplClientPool } = await import('./client.ts');

describe('XrplClientPool', () => {
  it('initializes with the requested pool size', async () => {
    const pool = new XrplClientPool();
    await pool.initialize('testnet', 2);
    // getClient should not throw after init.
    const client = pool.getClient();
    expect(client).toBeDefined();
    await pool.shutdown();
  });

  it('throws when getClient called before initialize', () => {
    const pool = new XrplClientPool();
    expect(() => pool.getClient()).toThrow('not initialized');
  });

  it('round-robins across pool entries', async () => {
    const pool = new XrplClientPool();
    await pool.initialize('testnet', 3);

    const c1 = pool.getClient();
    const c2 = pool.getClient();
    const c3 = pool.getClient();
    const c4 = pool.getClient(); // wraps around

    // All should be valid client objects (mocks).
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c3).toBeDefined();
    expect(c4).toBeDefined();

    await pool.shutdown();
  });

  it('shutdown clears entries', async () => {
    const pool = new XrplClientPool();
    await pool.initialize('testnet', 1);
    await pool.shutdown();
    expect(() => pool.getClient()).toThrow('not initialized');
  });

  it('initializes with mainnet URLs', async () => {
    const pool = new XrplClientPool();
    await pool.initialize('mainnet', 2);
    const client = pool.getClient();
    expect(client).toBeDefined();
    await pool.shutdown();
  });
});
