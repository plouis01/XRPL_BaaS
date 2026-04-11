// In-memory sliding-window rate limiter used as a fallback when Redis
// is unreachable. Sprint 7 (#16): both rateLimit.ts and ipRateLimit.ts
// fail open today when the Redis pipeline throws or returns null, which
// turns our primary DoS defense into no defense at all during an
// outage. This module is what they fall back to instead.
//
// Characteristics:
//   - Per-process state: each API node keeps its own fallback bucket.
//     Under a N-node fleet, an attacker gets an effective limit of
//     N × limit during an outage. That's still orders of magnitude
//     better than unlimited.
//   - No cross-process coordination. That's the point — Redis IS the
//     coordination layer and we're by definition without it here.
//   - Bounded memory: MAX_KEYS caps the distinct bucket count, and
//     MAX_ENTRIES_PER_KEY caps the timestamp log size per bucket.
//     A single attacker spraying a key can't pin the process RSS.
//   - Same sliding-window algorithm as the Redis limiter: we log each
//     hit's timestamp, then on every call drop entries older than
//     `now - windowMs` before returning the count.

const MAX_KEYS = 10_000;
const MAX_ENTRIES_PER_KEY = 5_000;

export class InMemoryRateLimiter {
  // Map iteration order is insertion order in JS, so the first key we
  // see when evicting is the oldest — a natural FIFO. Good enough for
  // a memory cap; we're not trying to build an LRU here.
  private buckets = new Map<string, number[]>();

  /**
   * Record a request in `key`'s bucket and return the current count
   * (including the new request). Callers compare against their own
   * limit: `count > limit` → reject.
   *
   * `now` is injectable for deterministic tests.
   */
  hit(key: string, windowMs: number, now: number = Date.now()): number {
    // Cap the distinct-bucket count. Evict the oldest entry if we're
    // about to insert a new key and we're at capacity.
    if (!this.buckets.has(key) && this.buckets.size >= MAX_KEYS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }

    const windowStart = now - windowMs;
    const existing = this.buckets.get(key) ?? [];

    // Drop expired timestamps. The log is sorted ascending (we append
    // `now` at each hit), so we can scan from the front and slice once.
    let firstLive = 0;
    while (firstLive < existing.length) {
      const ts = existing[firstLive];
      if (ts === undefined || ts > windowStart) break;
      firstLive++;
    }
    const trimmed = firstLive > 0 ? existing.slice(firstLive) : existing;

    trimmed.push(now);

    // Per-key memory cap: if a single key somehow accumulates more
    // timestamps than we're willing to store, drop the oldest so the
    // list stays bounded. This matters when an attacker saturates a
    // bucket while Redis is down — the rate limiter will already be
    // rejecting them, but we still don't want the log itself to grow
    // without bound.
    if (trimmed.length > MAX_ENTRIES_PER_KEY) {
      trimmed.splice(0, trimmed.length - MAX_ENTRIES_PER_KEY);
    }

    this.buckets.set(key, trimmed);
    return trimmed.length;
  }

  /** Test helper — wipe all state so tests don't leak into each other. */
  reset(): void {
    this.buckets.clear();
  }

  /** Test helper — expose size for assertions about bucket eviction. */
  size(): number {
    return this.buckets.size;
  }
}

// Single shared instance so rateLimit.ts and ipRateLimit.ts both see
// the same fallback state during a Redis outage. They use different
// key prefixes (`railforge:rl:` vs `railforge:ip:`), so there's no
// collision risk from sharing one map.
export const memoryRateLimiter = new InMemoryRateLimiter();
