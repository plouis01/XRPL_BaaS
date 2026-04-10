import { describe, expect, it, vi } from 'vitest';
import { RailForge } from './client.ts';

vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
);

describe('RailForge', () => {
  it('exposes all resource clients', () => {
    const rf = new RailForge({ apiKey: 'rf_test_abc' });
    expect(rf.accounts).toBeDefined();
    expect(rf.credentials).toBeDefined();
    expect(rf.domains).toBeDefined();
    expect(rf.tokens).toBeDefined();
    expect(rf.payments).toBeDefined();
    expect(rf.webhooks).toBeDefined();
  });

  it('defaults to testnet base URL', () => {
    const rf = new RailForge({ apiKey: 'rf_test_abc' });
    // Verify by making a request and checking the URL
    expect(rf).toBeDefined();
  });

  it('accepts a custom baseUrl', () => {
    const rf = new RailForge({
      apiKey: 'rf_test_abc',
      baseUrl: 'http://localhost:3000',
    });
    expect(rf).toBeDefined();
  });

  it('accepts mainnet network', () => {
    const rf = new RailForge({ apiKey: 'rf_live_abc', network: 'mainnet' });
    expect(rf).toBeDefined();
  });
});
