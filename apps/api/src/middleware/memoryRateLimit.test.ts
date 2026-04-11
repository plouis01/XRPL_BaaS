// Unit tests for the in-process sliding-window limiter used as the
// Redis fallback. Sprint 7 (#16).

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from './memoryRateLimit.ts';

describe('InMemoryRateLimiter', () => {
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    limiter = new InMemoryRateLimiter();
  });

  it('returns 1 on the first hit for a key', () => {
    expect(limiter.hit('k1', 60_000, 1000)).toBe(1);
  });

  it('increments the count on subsequent hits within the window', () => {
    expect(limiter.hit('k1', 60_000, 1000)).toBe(1);
    expect(limiter.hit('k1', 60_000, 1100)).toBe(2);
    expect(limiter.hit('k1', 60_000, 1200)).toBe(3);
  });

  it('isolates buckets by key', () => {
    limiter.hit('k1', 60_000, 1000);
    limiter.hit('k1', 60_000, 1100);
    limiter.hit('k1', 60_000, 1200);

    // Fresh key — unaffected by k1's count.
    expect(limiter.hit('k2', 60_000, 1300)).toBe(1);
  });

  it('drops entries older than (now - windowMs) so the bucket effectively resets', () => {
    // Seed two entries at t=1000ms.
    limiter.hit('k1', 60_000, 1000);
    limiter.hit('k1', 60_000, 1100);
    expect(limiter.hit('k1', 60_000, 1200)).toBe(3);

    // Advance time 90s — both original entries fall out of the window.
    // Only the new hit at t=91_200 survives.
    expect(limiter.hit('k1', 60_000, 91_200)).toBe(1);
  });

  it('partially drops entries: mid-window eviction keeps live ones', () => {
    // Three entries: t=1000, t=1100, t=30000.
    limiter.hit('k1', 60_000, 1000);
    limiter.hit('k1', 60_000, 1100);
    limiter.hit('k1', 60_000, 30_000);

    // At t=65_000 the 60s window starts at 5_000, which drops the first
    // two entries but keeps the one at 30_000. The new hit brings count
    // to 2.
    expect(limiter.hit('k1', 60_000, 65_000)).toBe(2);
  });

  it('caps the bucket count and evicts the oldest key (FIFO) when at capacity', () => {
    // Stress test: push 10_001 distinct keys to force one eviction.
    // MAX_KEYS is 10_000 and the cap is enforced "when inserting a new
    // key that doesn't already exist".
    const MAX_KEYS = 10_000;
    for (let i = 0; i < MAX_KEYS; i++) {
      limiter.hit(`k${i}`, 60_000, 1000 + i);
    }
    expect(limiter.size()).toBe(MAX_KEYS);

    // One more distinct key triggers eviction of the FIRST one we wrote (k0).
    limiter.hit('k-new', 60_000, 1000 + MAX_KEYS);
    expect(limiter.size()).toBe(MAX_KEYS);

    // k0 got evicted, so its count restarts at 1.
    expect(limiter.hit('k0', 60_000, 2000 + MAX_KEYS)).toBe(1);
  });

  it('re-hitting an existing key never triggers eviction, even at MAX_KEYS', () => {
    // Seed exactly MAX_KEYS. The next hit on an EXISTING key must not
    // evict anything — only new keys trigger eviction.
    const MAX_KEYS = 10_000;
    for (let i = 0; i < MAX_KEYS; i++) {
      limiter.hit(`k${i}`, 60_000, 1000 + i);
    }
    const sizeBefore = limiter.size();

    // Multiple hits on k0 — should increment count, not evict.
    limiter.hit('k0', 60_000, 50_000);
    limiter.hit('k0', 60_000, 50_100);
    expect(limiter.size()).toBe(sizeBefore);
  });

  it('caps per-key entries at MAX_ENTRIES_PER_KEY', () => {
    const MAX_ENTRIES_PER_KEY = 5_000;
    // Push 5_005 entries into a single bucket within a tight window.
    // After the cap kicks in, each new hit still returns MAX_ENTRIES_PER_KEY
    // (not 5001, 5002, ...) because the oldest is spliced off.
    let lastCount = 0;
    for (let i = 0; i < MAX_ENTRIES_PER_KEY + 5; i++) {
      lastCount = limiter.hit('spam', 60_000, 1000 + i);
    }
    expect(lastCount).toBe(MAX_ENTRIES_PER_KEY);
  });

  it('reset() clears all state', () => {
    limiter.hit('k1', 60_000, 1000);
    limiter.hit('k2', 60_000, 1000);
    expect(limiter.size()).toBe(2);

    limiter.reset();
    expect(limiter.size()).toBe(0);
    // And a subsequent hit starts from 1 again.
    expect(limiter.hit('k1', 60_000, 1000)).toBe(1);
  });
});
