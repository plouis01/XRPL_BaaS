// Reconnect lifecycle tests for LedgerSubscriber (Sprint 7, PLAN.md §9.2 G-2).
//
// Mocks the xrpl Client class to test connect/disconnect/reconnect
// without a live WebSocket. Uses vi.useFakeTimers() for deterministic
// backoff verification.
//
// vi.mock is hoisted above all other code by Vitest's transform, so
// any classes/variables the mock factory references must be declared
// inside vi.hoisted() to be available at hoist time.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mock infrastructure ──────────────────────────────────────────────

const { MockClient, clientInstances, connectShouldFail } = vi.hoisted(() => {
  const connectShouldFail = { value: false };
  const clientInstances: Array<{
    connectCalls: number;
    disconnectCalls: number;
    requestCalls: unknown[];
    emit: (event: string, ...args: unknown[]) => void;
  }> = [];

  class MockClient {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    connectCalls = 0;
    disconnectCalls = 0;
    requestCalls: unknown[] = [];
    private _connected = false;

    constructor() {
      clientInstances.push(this);
    }

    async connect(): Promise<void> {
      this.connectCalls++;
      if (connectShouldFail.value) throw new Error('connection refused');
      this._connected = true;
    }

    async disconnect(): Promise<void> {
      this.disconnectCalls++;
      this._connected = false;
    }

    isConnected(): boolean {
      return this._connected;
    }

    async request(req: unknown): Promise<{ result: Record<string, unknown> }> {
      this.requestCalls.push(req);
      return { result: {} };
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const existing = this.handlers.get(event) ?? [];
      existing.push(handler);
      this.handlers.set(event, existing);
    }

    emit(event: string, ...args: unknown[]): void {
      const handlers = this.handlers.get(event) ?? [];
      for (const h of handlers) h(...args);
    }
  }

  return { MockClient, clientInstances, connectShouldFail };
});

vi.mock('xrpl', () => ({
  Client: MockClient,
}));

vi.mock('./logger.ts', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const { LedgerSubscriber } = await import('./subscriber.ts');

function latestClient(): (typeof clientInstances)[number] {
  return clientInstances[clientInstances.length - 1]!;
}

describe('LedgerSubscriber reconnect lifecycle', () => {
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    handler = vi.fn();
    connectShouldFail.value = false;
    clientInstances.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('connects and subscribes to the ledger stream on start()', async () => {
    const sub = new LedgerSubscriber('wss://test', handler);
    await sub.start();

    expect(clientInstances).toHaveLength(1);
    expect(latestClient().connectCalls).toBe(1);
    expect(latestClient().requestCalls).toEqual([{ command: 'subscribe', streams: ['ledger'] }]);

    await sub.stop();
  });

  it('schedules reconnect on disconnect, creating a new Client', async () => {
    const sub = new LedgerSubscriber('wss://test', handler);
    await sub.start();
    expect(clientInstances).toHaveLength(1);

    latestClient().emit('disconnected', 1006);

    await vi.advanceTimersByTimeAsync(1001);
    expect(clientInstances).toHaveLength(2);
    expect(latestClient().connectCalls).toBe(1);

    await sub.stop();
  });

  it('doubles backoff on successive failures, capped at 30s', async () => {
    connectShouldFail.value = true;
    const sub = new LedgerSubscriber('wss://test', handler);
    await sub.start();
    expect(clientInstances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1001);
    expect(clientInstances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2001);
    expect(clientInstances).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(4001);
    expect(clientInstances).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(8001);
    expect(clientInstances).toHaveLength(5);

    await vi.advanceTimersByTimeAsync(16001);
    expect(clientInstances).toHaveLength(6);

    // 30s cap — not 32s.
    await vi.advanceTimersByTimeAsync(30001);
    expect(clientInstances).toHaveLength(7);

    await sub.stop();
  });

  it('resets backoff to 1s after a successful reconnect', async () => {
    connectShouldFail.value = true;
    const sub = new LedgerSubscriber('wss://test', handler);
    await sub.start();
    expect(clientInstances).toHaveLength(1);

    // 1s → 2nd attempt fails.
    await vi.advanceTimersByTimeAsync(1001);
    expect(clientInstances).toHaveLength(2);

    // Let the 2s reconnect succeed.
    connectShouldFail.value = false;
    await vi.advanceTimersByTimeAsync(2001);
    expect(clientInstances).toHaveLength(3);

    // Simulate another disconnect — backoff should reset to 1s.
    latestClient().emit('disconnected', 1006);

    await vi.advanceTimersByTimeAsync(1001);
    expect(clientInstances).toHaveLength(4);
    expect(latestClient().connectCalls).toBe(1);

    await sub.stop();
  });

  it('fires the handler on ledgerClosed events', async () => {
    const sub = new LedgerSubscriber('wss://test', handler);
    await sub.start();

    latestClient().emit('ledgerClosed', {
      ledger_index: 100,
      ledger_hash: 'ABC123',
      ledger_time: 800000000,
      txn_count: 5,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledWith({
      ledgerIndex: 100,
      ledgerHash: 'ABC123',
      closeTime: 800000000,
      txCount: 5,
    });

    await sub.stop();
  });

  it('stop() prevents further reconnect attempts', async () => {
    const sub = new LedgerSubscriber('wss://test', handler);
    await sub.start();
    const countBefore = clientInstances.length;

    latestClient().emit('disconnected', 1006);
    await sub.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(clientInstances).toHaveLength(countBefore);
  });

  it('start() is idempotent when already running', async () => {
    const sub = new LedgerSubscriber('wss://test', handler);
    await sub.start();
    await sub.start();

    expect(clientInstances).toHaveLength(1);
    expect(latestClient().connectCalls).toBe(1);
    await sub.stop();
  });
});
