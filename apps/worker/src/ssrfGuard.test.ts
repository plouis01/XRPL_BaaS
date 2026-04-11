// Unit tests for the SSRF guard used by the webhook delivery worker.
// Sprint 7 (#18).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:dns/promises BEFORE importing the guard so the mock is
// wired in when the module-level lookup binding is resolved.
const dnsLookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (hostname: string) => dnsLookupMock(hostname),
}));

import type { SsrfBlockedError as SsrfBlockedErrorType } from './ssrfGuard.ts';

const { isPrivateIp, resolveAndValidateHostname, SsrfBlockedError } = await import(
  './ssrfGuard.ts'
);

describe('isPrivateIp', () => {
  // Public-routable IPs that must NOT be blocked.
  it.each([
    ['8.8.8.8'], // Google DNS
    ['1.1.1.1'], // Cloudflare DNS
    ['93.184.216.34'], // example.com
    ['13.32.0.1'], // AWS Cloudfront (public)
    ['2606:4700:4700::1111'], // Cloudflare IPv6
    ['2001:4860:4860::8888'], // Google IPv6
  ])('allows public IP %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  // IPv4 private/reserved ranges.
  it.each([
    ['127.0.0.1'], // loopback
    ['127.255.255.254'], // loopback edge
    ['10.0.0.1'], // RFC 1918
    ['10.255.255.255'],
    ['172.16.0.1'], // RFC 1918
    ['172.31.255.255'],
    ['192.168.0.1'], // RFC 1918
    ['192.168.255.255'],
    ['169.254.169.254'], // AWS metadata IMDS
    ['169.254.1.1'], // link-local
    ['0.0.0.0'],
    ['0.1.2.3'], // 0/8
    ['100.64.0.1'], // CGNAT
    ['100.127.255.254'],
    ['224.0.0.1'], // multicast
    ['239.255.255.255'],
    ['240.0.0.1'], // reserved
    ['255.255.255.255'], // broadcast
  ])('blocks private IPv4 %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  // IPv6 private/reserved ranges.
  it.each([
    ['::1'], // loopback
    ['::'], // unspecified
    ['fc00::1'], // unique local
    ['fd12:3456::1'], // unique local
    ['fe80::1'], // link-local
    ['feab::1'], // link-local
    ['ff02::1'], // multicast
  ])('blocks private IPv6 %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 RFC 1918 (::ffff:10.0.0.1)', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
  });

  it('allows IPv4-mapped IPv6 public IP (::ffff:8.8.8.8)', () => {
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('rejects the empty string as a safety default', () => {
    expect(isPrivateIp('')).toBe(true);
  });

  it('is case-insensitive for IPv6 (FE80::1 === fe80::1)', () => {
    expect(isPrivateIp('FE80::1')).toBe(true);
    expect(isPrivateIp('::FFFF:127.0.0.1')).toBe(true);
  });
});

describe('resolveAndValidateHostname', () => {
  beforeEach(() => {
    dnsLookupMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves and returns the address on a public IP', async () => {
    dnsLookupMock.mockResolvedValueOnce({
      address: '93.184.216.34',
      family: 4,
    });

    const result = await resolveAndValidateHostname('example.com');
    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
    expect(dnsLookupMock).toHaveBeenCalledWith('example.com');
  });

  it('throws SsrfBlockedError when the hostname resolves to AWS metadata', async () => {
    dnsLookupMock.mockResolvedValueOnce({
      address: '169.254.169.254',
      family: 4,
    });

    await expect(resolveAndValidateHostname('evil.com')).rejects.toThrow(SsrfBlockedError);
  });

  it('throws SsrfBlockedError with hostname + resolved IP on the error', async () => {
    dnsLookupMock.mockResolvedValueOnce({
      address: '10.0.0.1',
      family: 4,
    });

    try {
      await resolveAndValidateHostname('attacker.io');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      const e = err as SsrfBlockedErrorType;
      expect(e.hostname).toBe('attacker.io');
      expect(e.resolvedIp).toBe('10.0.0.1');
      expect(e.message).toMatch(/10\.0\.0\.1/);
    }
  });

  it('propagates DNS resolution errors (NXDOMAIN) to the caller', async () => {
    const nxdomain = Object.assign(new Error('getaddrinfo ENOTFOUND foo.invalid'), {
      code: 'ENOTFOUND',
    });
    dnsLookupMock.mockRejectedValueOnce(nxdomain);

    // NXDOMAIN is a transient network condition, not an SSRF block — the
    // caller must see the raw error so it can decide to retry.
    await expect(resolveAndValidateHostname('foo.invalid')).rejects.toThrow(/ENOTFOUND/);
    // And specifically NOT an SsrfBlockedError.
    await expect(resolveAndValidateHostname('foo.invalid')).rejects.not.toThrow(SsrfBlockedError);
  });

  it('rejects IPv6 loopback (::1)', async () => {
    dnsLookupMock.mockResolvedValueOnce({ address: '::1', family: 6 });
    await expect(resolveAndValidateHostname('v6evil.com')).rejects.toThrow(SsrfBlockedError);
  });
});
