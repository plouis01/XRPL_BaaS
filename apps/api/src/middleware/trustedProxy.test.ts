// Unit tests for the trusted-proxy allowlist (REVIEW.md M-1).

import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getClientIp, resetTrustedProxyCache } from './trustedProxy.ts';

/**
 * Build a minimal Context-shaped object. We only exercise the exact
 * fields `getClientIp` reads — headers + `c.env.server.requestIP()`.
 */
function makeCtx(opts: {
  headers?: Record<string, string>;
  peerIp?: string;
  peerThrows?: boolean;
  noServer?: boolean;
}): Context {
  const headers = opts.headers ?? {};
  const fakeRequest = new Request('https://test.local/v1/anything');
  const server = opts.noServer
    ? undefined
    : {
        requestIP: (_req: Request) => {
          if (opts.peerThrows) throw new Error('runtime borked');
          if (opts.peerIp === undefined) return null;
          return { address: opts.peerIp, family: 'IPv4', port: 12345 };
        },
      };
  // biome-ignore lint/suspicious/noExplicitAny: we only ever set what the helper reads
  const c: any = {
    env: { server },
    req: {
      raw: fakeRequest,
      header: (name: string) => headers[name.toLowerCase()],
    },
  };
  return c as Context;
}

describe('getClientIp — TRUSTED_PROXY_IPS unset (legacy behavior)', () => {
  const originalEnv = process.env.TRUSTED_PROXY_IPS;

  beforeEach(() => {
    process.env.TRUSTED_PROXY_IPS = undefined;
    // biome-ignore lint/performance/noDelete: process.env coerces undefined to literal "undefined"
    delete process.env.TRUSTED_PROXY_IPS;
    resetTrustedProxyCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: see above
      delete process.env.TRUSTED_PROXY_IPS;
    } else {
      process.env.TRUSTED_PROXY_IPS = originalEnv;
    }
    resetTrustedProxyCache();
  });

  it('returns CF-Connecting-IP when present', () => {
    const c = makeCtx({
      headers: { 'cf-connecting-ip': '203.0.113.5' },
      peerIp: '10.0.0.1',
    });
    expect(getClientIp(c)).toBe('203.0.113.5');
  });

  it('returns the first XFF entry when CF header is missing', () => {
    const c = makeCtx({
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
      peerIp: '10.0.0.1',
    });
    expect(getClientIp(c)).toBe('198.51.100.7');
  });

  it('falls back to the peer IP when no forwarded headers are present', () => {
    const c = makeCtx({ peerIp: '10.0.0.1' });
    expect(getClientIp(c)).toBe('10.0.0.1');
  });

  it('returns "unknown" when no headers and no peer IP are available', () => {
    const c = makeCtx({ noServer: true });
    expect(getClientIp(c)).toBe('unknown');
  });
});

describe('getClientIp — TRUSTED_PROXY_IPS set (REVIEW.md M-1)', () => {
  const originalEnv = process.env.TRUSTED_PROXY_IPS;

  beforeEach(() => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.1, 10.0.0.2';
    resetTrustedProxyCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: see above
      delete process.env.TRUSTED_PROXY_IPS;
    } else {
      process.env.TRUSTED_PROXY_IPS = originalEnv;
    }
    resetTrustedProxyCache();
  });

  it('honors CF-Connecting-IP when the peer is in the allowlist', () => {
    const c = makeCtx({
      headers: { 'cf-connecting-ip': '203.0.113.5' },
      peerIp: '10.0.0.1',
    });
    expect(getClientIp(c)).toBe('203.0.113.5');
  });

  it('honors X-Forwarded-For when the peer is in the allowlist', () => {
    const c = makeCtx({
      headers: { 'x-forwarded-for': '198.51.100.7' },
      peerIp: '10.0.0.2',
    });
    expect(getClientIp(c)).toBe('198.51.100.7');
  });

  it('IGNORES forged CF-Connecting-IP when the peer is NOT trusted', () => {
    // Attacker connects directly and forges the CF header.
    const c = makeCtx({
      headers: { 'cf-connecting-ip': '1.2.3.4' }, // attacker-controlled
      peerIp: '203.0.113.99', // attacker's real IP
    });
    // Must return the real peer IP, not the forged header.
    expect(getClientIp(c)).toBe('203.0.113.99');
  });

  it('IGNORES forged X-Forwarded-For when the peer is NOT trusted', () => {
    const c = makeCtx({
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      peerIp: '203.0.113.99',
    });
    expect(getClientIp(c)).toBe('203.0.113.99');
  });

  it('returns "unknown" when peer IP is not available and feature is enabled', () => {
    // Test harness / runtime without requestIP — can't verify the peer,
    // so we conservatively ignore headers and report 'unknown'.
    const c = makeCtx({
      headers: { 'cf-connecting-ip': '1.2.3.4' },
      noServer: true,
    });
    expect(getClientIp(c)).toBe('unknown');
  });

  it('falls back to peer IP when trusted but no forwarded header is set', () => {
    const c = makeCtx({ peerIp: '10.0.0.1' });
    expect(getClientIp(c)).toBe('10.0.0.1');
  });

  it('handles runtime throwing from requestIP() gracefully', () => {
    const c = makeCtx({
      headers: { 'cf-connecting-ip': '1.2.3.4' },
      peerThrows: true,
    });
    // requestIP threw → no peer → ignore forwarded headers.
    expect(getClientIp(c)).toBe('unknown');
  });
});
