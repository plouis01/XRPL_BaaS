// XRP/USD price oracle.
//
// Powers the USD-denominated spend caps (migration 0019). Two surfaces:
//
//   - getXrpUsdRateCents()      — returns cents per 1 XRP, with metadata
//                                 (source, fetchedAt) for the dashboard.
//   - dropsToUsdCents(drops)    — convenience: rate × drops ÷ 1_000_000.
//
// Source preference, in order:
//   1. CoinGecko Demo API (api.coingecko.com/api/v3/simple/price)
//      Auth header `x-cg-demo-api-key: $COINGECKO`. 30 calls/min on the
//      free tier — well above what a 60s cache demands.
//   2. Fallback rate from `XRP_USD_FALLBACK_CENTS` (default 50 cents).
//      Kicks in when the Demo key is missing, the request fails, or
//      the response shape is unexpected. Failure is logged once per
//      window so ops can alert on prolonged staleness.
//
// Cache: a single in-process slot keyed by nothing — XRP/USD is global.
// 60s TTL matches the price-feed update cadence on the free tier and
// keeps the call count low.
//
// SECURITY: this is a hardcoded outbound to a single host (no
// user-controlled URL component), so it does NOT need to go through
// ssrfGuard.ts. Adding any user-influenced field to the URL later
// (e.g. a custom feed) would change that — route through the guard.

import { logger } from '../logger.ts';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd';
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const FALLBACK_CENTS_DEFAULT = 50; // $0.50 — conservative undershoot

export type RateSource = 'coingecko' | 'fallback';

export interface XrpUsdRate {
  /** Cents per 1 XRP. Always a positive integer. */
  cents: number;
  source: RateSource;
  /** Wall-clock time the rate was retrieved (ms since epoch). */
  fetchedAt: number;
}

interface CachedRate extends XrpUsdRate {
  expiresAt: number;
}

let cache: CachedRate | null = null;

function getFallbackCents(): number {
  const raw = process.env.XRP_USD_FALLBACK_CENTS;
  if (!raw) return FALLBACK_CENTS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return FALLBACK_CENTS_DEFAULT;
  return n;
}

async function fetchFromCoinGecko(): Promise<number | null> {
  const key = process.env.COINGECKO;
  if (!key) {
    logger.warn('price oracle: COINGECKO env var missing, using fallback rate');
    return null;
  }

  // AbortController-based timeout — `fetch` doesn't honor a global one.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: { 'x-cg-demo-api-key': key, accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'price oracle: CoinGecko returned non-2xx, using fallback',
      );
      return null;
    }
    const body = (await res.json()) as { ripple?: { usd?: number } };
    const usd = body.ripple?.usd;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
      logger.warn({ body }, 'price oracle: CoinGecko response missing ripple.usd, using fallback');
      return null;
    }
    // Round to integer cents. $0.5234 → 52 cents (truncates; conservative
    // for spend caps — the agent gets a slightly tighter limit).
    return Math.floor(usd * 100);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'price oracle: CoinGecko fetch failed, using fallback',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the current XRP/USD rate in cents. Cached for 60s. On the
 * first miss after expiry, blocks the caller for up to REQUEST_TIMEOUT_MS
 * waiting for CoinGecko; returns the fallback if the request fails.
 */
export async function getXrpUsdRateCents(): Promise<XrpUsdRate> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) {
    return {
      cents: cache.cents,
      source: cache.source,
      fetchedAt: cache.fetchedAt,
    };
  }

  const live = await fetchFromCoinGecko();
  const rate: XrpUsdRate = live
    ? { cents: live, source: 'coingecko', fetchedAt: now }
    : { cents: getFallbackCents(), source: 'fallback', fetchedAt: now };
  cache = { ...rate, expiresAt: now + CACHE_TTL_MS };
  return rate;
}

/** Convert XRP drops to USD cents using the current rate. Drops > MAX_SAFE_INTEGER
 *  go through bigint to preserve precision. */
export async function dropsToUsdCents(drops: string | bigint): Promise<bigint> {
  const dropsBig = typeof drops === 'bigint' ? drops : BigInt(drops);
  if (dropsBig <= 0n) return 0n;
  const rate = await getXrpUsdRateCents();
  return (dropsBig * BigInt(rate.cents)) / 1_000_000n;
}

/**
 * Convert a decimal token amount string (e.g. "10.50") to integer cents,
 * assuming the token is 1:1 with USD (i.e. RLUSD). Truncates beyond two
 * decimal places — the spend cap doesn't care about sub-cent precision.
 *
 * Returns null on malformed input so the caller can fall through to the
 * op-count enforcement path (the same behavior as a non-XRP/non-RLUSD tx).
 */
export function rlusdValueToUsdCents(value: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const fracPadded = `${frac}00`.slice(0, 2); // pad to 2 decimals, truncate beyond
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  try {
    return BigInt(combined);
  } catch {
    return null;
  }
}

/** Drop the cached rate. Exported for tests. */
export function clearPriceCache(): void {
  cache = null;
}
