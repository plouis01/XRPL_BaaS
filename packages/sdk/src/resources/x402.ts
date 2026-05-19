// x402 SDK resource. SPRINT_10_PLAN.md §4.9.
//
// Two surfaces:
//
//   1. `pay(url, options)` — drives the HTTP-402 protocol against an
//      arbitrary URL (not just RailForge endpoints). The caller passes
//      a `signer` implementation; we orchestrate request → 402 → sign →
//      retry-with-X-PAYMENT.
//
//   2. RailForge management — verifyRemote, intents.get, routes CRUD.
//      All hit the authenticated /v1/x402/* surface via the SDK's
//      shared HttpClient.
//
// The SDK has zero runtime dependencies by design. The X-PAYMENT wire
// format (base64 of JSON `{intent_id, tx_hash}`) is small enough to
// inline here without pulling @railforge/xrpl-core into the public
// dependency tree.

import type { HttpClient } from '../http.ts';
import type {
  CreateX402RouteParams,
  RequestOptions,
  X402Intent,
  X402PayOptions,
  X402Quote,
  X402Route,
  X402RouteList,
  X402VerifyResult,
} from '../types.ts';

const X_PAYMENT_HEADER = 'X-PAYMENT';
const MAX_RETRIES_HARD_CAP = 3;

/**
 * Encode the X-PAYMENT header value the way the API verifier decodes it
 * (apps/api/src/middleware/x402.ts via @railforge/xrpl-core). Wire format:
 *   base64(utf8(JSON.stringify({ intent_id, tx_hash })))
 *
 * Kept inline so the SDK stays dependency-free; this is short enough
 * that the duplication cost is lower than the bundle-size cost of
 * pulling in xrpl-core.
 */
function encodePaymentHeader(intentId: string, txHash: string): string {
  const json = JSON.stringify({ intent_id: intentId, tx_hash: txHash });
  // Use btoa where available; fall back to Buffer for Node-only callers
  // (vitest, certain bundler targets). globalThis.btoa is present in
  // every supported Node version + every browser, but we still guard.
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(json);
  }
  return Buffer.from(json, 'utf8').toString('base64');
}

function isX402Quote(value: unknown): value is X402Quote {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.x402_version === 1 &&
    typeof v.intent_id === 'string' &&
    typeof v.payee === 'string' &&
    typeof v.asset === 'string' &&
    typeof v.amount === 'string' &&
    typeof v.destination_tag === 'number'
  );
}

export class X402Routes {
  constructor(private http: HttpClient) {}

  /** Register a gated path on this client's tenant. Returns the route row. */
  async create(params: CreateX402RouteParams, opts?: RequestOptions): Promise<X402Route> {
    return this.http.post<X402Route>('/v1/x402/routes', params, opts?.idempotencyKey);
  }

  /** List this client's gated routes (active + soft-deleted). */
  async list(): Promise<X402RouteList> {
    return this.http.get<X402RouteList>('/v1/x402/routes');
  }

  /** Soft-delete a route by id. */
  async delete(routeId: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete<null>(`/v1/x402/routes/${routeId}`, undefined, opts?.idempotencyKey);
  }
}

export class X402 {
  readonly routes: X402Routes;

  constructor(private http: HttpClient) {
    this.routes = new X402Routes(http);
  }

  /**
   * Drive an x402-gated request to completion.
   *
   * Flow:
   *   1. Issue the initial request (the standard `fetch` call your app
   *      would make to the gated URL).
   *   2. If the response is 402 with an x402 quote body, ask the signer
   *      to settle on-ledger and wait for validation.
   *   3. Retry the original request with the `X-PAYMENT` header.
   *   4. If the retry returns 402 again (e.g. the server re-quotes with
   *      `reason=tag_mismatch`), repeat up to `maxRetries` times.
   *
   * Any non-402 response (including 4xx / 5xx) is returned to the caller
   * verbatim. The SDK never retries non-402 failures — the protocol
   * doesn't say what they mean.
   */
  async pay(url: string, options: X402PayOptions): Promise<Response> {
    if (!options || typeof options.signer !== 'object' || options.signer === null) {
      throw new Error('x402.pay: options.signer is required');
    }
    const maxRetries = Math.min(options.maxRetries ?? 1, MAX_RETRIES_HARD_CAP);

    // Strip the signer/maxRetries from the fetch init so we don't surprise
    // `fetch` with unknown fields. Everything else (method, body,
    // credentials, signal, etc.) passes through.
    const { signer, maxRetries: _maxRetries, headers: extraHeaders, ...fetchInit } = options;

    const baseHeaders: Record<string, string> = { ...(extraHeaders ?? {}) };

    let res = await fetch(url, { ...fetchInit, headers: baseHeaders });

    // Loop bound: `maxRetries` retries means up to `maxRetries` signer
    // calls (one per retry). The initial fetch above is attempt 0; each
    // iteration here turns one 402 into one signed retry.
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (res.status !== 402) return res;

      // Parse the quote. If the body is unrecognisable we return the 402
      // verbatim — the caller can inspect it.
      const cloned = res.clone();
      let quote: unknown;
      try {
        quote = await cloned.json();
      } catch {
        return res;
      }
      if (!isX402Quote(quote)) return res;

      // Settle on-chain via the user's signer. A throw aborts pay() —
      // the caller sees the signer's error.
      const { tx_hash } = await signer.signAndSubmit({
        payee: quote.payee,
        asset: quote.asset,
        amount: quote.amount,
        destinationTag: quote.destination_tag,
      });

      // Retry with X-PAYMENT.
      const paymentHeader = encodePaymentHeader(quote.intent_id, tx_hash);
      const retryHeaders = {
        ...baseHeaders,
        [X_PAYMENT_HEADER]: paymentHeader,
      };
      res = await fetch(url, { ...fetchInit, headers: retryHeaders });
    }

    // Exhausted retries while still getting 402s — hand the last response
    // back so the caller can see the final reason.
    return res;
  }

  /**
   * Remote verifier endpoint (Mode B). Clients running their own server
   * forward the X-PAYMENT header values here from their backend, and
   * RailForge returns whether the on-chain Payment satisfies the intent.
   */
  async verifyRemote(params: {
    intent_id: string;
    tx_hash: string;
  }): Promise<X402VerifyResult> {
    return this.http.post<X402VerifyResult>('/v1/x402/verify', params);
  }

  /** Fetch an intent by id. Returns null when the API returns 404. */
  async getIntent(intentId: string): Promise<X402Intent | null> {
    try {
      return await this.http.get<X402Intent>(`/v1/x402/intents/${intentId}`);
    } catch (err) {
      // RailForgeError has a `status` field — opt for null on 404 since
      // callers consuming this for status checks would otherwise need to
      // wrap every call in try/catch.
      const status = (err as { status?: number })?.status;
      if (status === 404) return null;
      throw err;
    }
  }
}
