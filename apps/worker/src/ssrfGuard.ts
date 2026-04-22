// Delivery-time SSRF guard for outgoing HTTP requests.
//
// The webhook service already rejects private IPs and credentials in
// the URL at REGISTRATION time (apps/api/src/services/webhook.service.ts).
// But that check happens against the RAW hostname — an attacker who
// controls DNS for `attacker.com` can register a webhook that looks
// public and then flip the A record to 169.254.169.254 (cloud metadata),
// 10.0.0.1 (internal LAN), or 127.0.0.1 before delivery. Classic DNS
// rebinding.
//
// Sprint 7 (#18) fix: resolve the hostname ourselves at delivery time
// and reject if the resolved IP sits in a private/reserved range. Two
// layers of defense together — the registration-time regex catches
// literal private IPs in the URL, this catches them after resolution.
//
// Residual race: between `dns.lookup` below and undici's own lookup
// inside `fetch`, the attacker could theoretically flip DNS again if
// the OS resolver doesn't cache the result. In practice modern macOS
// (mDNSResponder) and Linux (systemd-resolved / nscd) cache for long
// enough that both calls see the same answer, and undici's keep-alive
// connection pool further reduces the window. Fully closing the race
// would require an undici Agent with a pinned `connect.lookup` — a
// future hardening if this turns out to be exploitable in practice.

import { lookup as dnsLookup } from 'node:dns/promises';

export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    public readonly hostname: string,
    public readonly resolvedIp: string,
  ) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Returns true if the given IP literal sits in a private/reserved
 * range that must not be reachable from an outgoing webhook fetch.
 * Handles both IPv4 and IPv6, including IPv4-mapped IPv6 addresses.
 *
 * Exported so unit tests can exercise every branch without standing up
 * a fake DNS resolver.
 */
export function isPrivateIp(address: string): boolean {
  const ip = address.toLowerCase().trim();
  if (ip.length === 0) return true;

  // ── IPv4 ────────────────────────────────────────────────────────────
  // Literal-match the well-known private, reserved, loopback, and
  // link-local ranges. We reject broadly — if in doubt, block.
  const ipv4 = [
    /^127\./, // 127/8 loopback
    /^10\./, // 10/8 RFC 1918
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16/12 RFC 1918
    /^192\.168\./, // 192.168/16 RFC 1918
    /^169\.254\./, // 169.254/16 link-local (AWS IMDS at 169.254.169.254)
    /^0\./, // 0/8 "this network"
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64/10 CGNAT
    /^192\.0\.0\./, // 192.0.0/24 IETF protocol assignments
    /^192\.0\.2\./, // 192.0.2/24 TEST-NET-1
    /^198\.(1[89])\./, // 198.18/15 benchmark
    /^198\.51\.100\./, // 198.51.100/24 TEST-NET-2
    /^203\.0\.113\./, // 203.0.113/24 TEST-NET-3
    /^22[4-9]\./, // 224/4 multicast (224-239)
    /^23[0-9]\./,
    /^24[0-9]\./, // 240/4 reserved (240-255)
    /^25[0-5]\./,
    /^255\.255\.255\.255$/, // limited broadcast
  ];
  if (ipv4.some((p) => p.test(ip))) return true;
  if (ip === '0.0.0.0') return true;

  // ── IPv6 ────────────────────────────────────────────────────────────
  if (ip === '::1' || ip === '::') return true;
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — recurse on the tail so the IPv4
  // patterns above apply.
  //
  // REVIEW.md LOW-02: the hex form (::ffff:7f00:1 == 127.0.0.1) used to
  // silently pass through because we only handled dotted-decimal. An
  // attacker could request `http://[::ffff:7f00:1]/` and escape the SSRF
  // guard even though the target IS loopback. Fix: decode the 2-group
  // hex form into IPv4 and recurse. Reject any `::ffff:` prefix we can't
  // decode into either form — unknown shapes are fail-closed.
  if (ip.startsWith('::ffff:')) {
    const tail = ip.slice('::ffff:'.length);
    // Dotted-decimal form: ::ffff:127.0.0.1 → recurse as IPv4.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isPrivateIp(tail);
    // Hex form: ::ffff:HHHH:HHHH (two 16-bit groups). The last one can
    // be abbreviated (::ffff:7f00:1 instead of ::ffff:7f00:0001).
    const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = Number.parseInt(hexMatch[1] as string, 16);
      const lo = Number.parseInt(hexMatch[2] as string, 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIp(dotted);
    }
    // Any other ::ffff:* shape is unexpected — fail closed.
    return true;
  }
  if (/^f[cd]/.test(ip)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
  if (/^ff/.test(ip)) return true; // ff00::/8 multicast

  return false;
}

/**
 * Resolve a hostname to an IP and reject if that IP is private or
 * reserved. Returns the resolved address + family on success.
 *
 * DNS lookup failures (NXDOMAIN, resolver unreachable, etc.) propagate
 * to the caller — the caller should treat them as transient network
 * errors, not SSRF rejections.
 */
export async function resolveAndValidateHostname(
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }> {
  const result = await dnsLookup(hostname);
  if (isPrivateIp(result.address)) {
    throw new SsrfBlockedError(
      `Webhook target ${hostname} resolved to private/reserved IP ${result.address}`,
      hostname,
      result.address,
    );
  }
  return { address: result.address, family: result.family as 4 | 6 };
}
