// Unit tests for the @railforge/sdk x402 resource.
//
// Two surfaces under test:
//   1. pay() — drives the full 402 → sign → retry → 200 cycle against
//      a stubbed `fetch`. We assert on the X-PAYMENT header value the
//      retry carries and on the signer being called with the right
//      derived (payee, asset, amount, tag).
//   2. verifyRemote / getIntent / routes CRUD — pass-through to the
//      shared HttpClient, mirroring the test pattern used by other
//      resource clients.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { X402 } from './x402.ts';

const PAYEE = 'rEHMTjmCNgxiGzgUTpV4Y1MwYpFpYz7e7p';
const INTENT_ID = 'x402_intent_ABCDEFGHJKMNPQRSTVWXYZ0123';
const TX_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function mockHttp() {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => null),
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function quote402(overrides: Record<string, unknown> = {}): unknown {
  return {
    x402_version: 1,
    intent_id: INTENT_ID,
    resource: '/echo',
    payee: PAYEE,
    asset: 'XRP',
    amount: '10000',
    destination_tag: 1234567,
    expires_at: '2099-01-01T00:00:00Z',
    ...overrides,
  };
}

function decodePaymentHeader(header: string): {
  intent_id: string;
  tx_hash: string;
} {
  // Mirror the SDK's encoder: base64 of JSON.
  const json =
    typeof globalThis.atob === 'function'
      ? globalThis.atob(header)
      : Buffer.from(header, 'base64').toString('utf8');
  return JSON.parse(json) as { intent_id: string; tx_hash: string };
}

// ── pay() ──────────────────────────────────────────────────────────────────

describe('X402.pay()', () => {
  let http: ReturnType<typeof mockHttp>;
  let x402: X402;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    http = mockHttp();
    x402 = new X402(http as never);
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function afterEach(fn: () => void) {
    // Inline shim so we don't need the vitest globals import.
    return fn;
  }

  it('returns non-402 responses verbatim without calling the signer', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const signer = { signAndSubmit: vi.fn() };
    const res = await x402.pay('https://example.test/echo', {
      method: 'POST',
      signer,
    });
    expect(res.status).toBe(200);
    expect(signer.signAndSubmit).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    globalThis.fetch = originalFetch;
  });

  it('runs the 402 → sign → retry cycle and returns the final response', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(402, quote402()))
      .mockResolvedValueOnce(jsonResponse(200, { echoed: { hi: 'there' } }));
    const signer = {
      signAndSubmit: vi.fn(async () => ({ tx_hash: TX_HASH })),
    };

    const res = await x402.pay('https://example.test/echo', {
      method: 'POST',
      body: JSON.stringify({ hi: 'there' }),
      signer,
    });
    expect(res.status).toBe(200);
    expect(signer.signAndSubmit).toHaveBeenCalledWith({
      payee: PAYEE,
      asset: 'XRP',
      amount: '10000',
      destinationTag: 1234567,
    });

    // 2nd fetch carries X-PAYMENT
    const retryCall = fetchSpy.mock.calls[1];
    expect(retryCall?.[0]).toBe('https://example.test/echo');
    const retryHeaders = (retryCall?.[1] as { headers?: Record<string, string> })?.headers ?? {};
    const payHeader = retryHeaders['X-PAYMENT'];
    expect(payHeader).toBeTypeOf('string');
    expect(decodePaymentHeader(payHeader!)).toEqual({
      intent_id: INTENT_ID,
      tx_hash: TX_HASH,
    });

    globalThis.fetch = originalFetch;
  });

  it('preserves caller-supplied headers on the retry', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(402, quote402()))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const signer = { signAndSubmit: vi.fn(async () => ({ tx_hash: TX_HASH })) };
    await x402.pay('https://example.test/echo', {
      method: 'POST',
      headers: { 'x-correlation-id': 'abc', authorization: 'Bearer xyz' },
      signer,
    });
    const retryHeaders =
      (fetchSpy.mock.calls[1]?.[1] as { headers?: Record<string, string> })?.headers ?? {};
    expect(retryHeaders['x-correlation-id']).toBe('abc');
    expect(retryHeaders.authorization).toBe('Bearer xyz');
    expect(retryHeaders['X-PAYMENT']).toBeDefined();
    globalThis.fetch = originalFetch;
  });

  it('returns the 402 verbatim when the body is unrecognisable', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(402, { not_an_x402_quote: true }));
    const signer = { signAndSubmit: vi.fn() };
    const res = await x402.pay('https://example.test/echo', { signer });
    expect(res.status).toBe(402);
    expect(signer.signAndSubmit).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it('propagates signer errors verbatim', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(402, quote402()));
    const signer = {
      signAndSubmit: vi.fn(async () => {
        throw new Error('user rejected');
      }),
    };
    await expect(x402.pay('https://example.test/echo', { signer })).rejects.toThrow(
      /user rejected/,
    );
    globalThis.fetch = originalFetch;
  });

  it('retries up to maxRetries when the server re-quotes 402', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(402, quote402()))
      .mockResolvedValueOnce(jsonResponse(402, quote402({ reason: 'tag_mismatch' })))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const signer = {
      signAndSubmit: vi.fn(async () => ({ tx_hash: TX_HASH })),
    };
    const res = await x402.pay('https://example.test/echo', {
      signer,
      maxRetries: 2,
    });
    expect(res.status).toBe(200);
    expect(signer.signAndSubmit).toHaveBeenCalledTimes(2);
    globalThis.fetch = originalFetch;
  });

  it('stops at the hard cap (3) even when maxRetries asks for more', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(402, quote402()))
      .mockResolvedValueOnce(jsonResponse(402, quote402()))
      .mockResolvedValueOnce(jsonResponse(402, quote402()))
      .mockResolvedValueOnce(jsonResponse(402, quote402()));
    const signer = {
      signAndSubmit: vi.fn(async () => ({ tx_hash: TX_HASH })),
    };
    const res = await x402.pay('https://example.test/echo', {
      signer,
      maxRetries: 99,
    });
    // After hard cap retries the final 402 is returned to the caller.
    expect(res.status).toBe(402);
    expect(signer.signAndSubmit).toHaveBeenCalledTimes(3);
    globalThis.fetch = originalFetch;
  });

  it('throws when signer is omitted', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately bad call
      x402.pay('https://example.test/echo', {} as any),
    ).rejects.toThrow(/signer is required/);
    globalThis.fetch = originalFetch;
  });
});

// ── verifyRemote / getIntent / routes ──────────────────────────────────────

describe('X402 management surface', () => {
  let http: ReturnType<typeof mockHttp>;
  let x402: X402;

  beforeEach(() => {
    http = mockHttp();
    x402 = new X402(http as never);
  });

  it('verifyRemote POSTs to /v1/x402/verify', async () => {
    http.post.mockResolvedValueOnce({
      ok: true,
      ledger_index: 99,
      intent_id: INTENT_ID,
    });
    const res = await x402.verifyRemote({
      intent_id: INTENT_ID,
      tx_hash: TX_HASH,
    });
    expect(res).toEqual({ ok: true, ledger_index: 99, intent_id: INTENT_ID });
    expect(http.post).toHaveBeenCalledWith('/v1/x402/verify', {
      intent_id: INTENT_ID,
      tx_hash: TX_HASH,
    });
  });

  it('getIntent GETs /v1/x402/intents/:id', async () => {
    http.get.mockResolvedValueOnce({ id: INTENT_ID } as never);
    await x402.getIntent(INTENT_ID);
    expect(http.get).toHaveBeenCalledWith(`/v1/x402/intents/${INTENT_ID}`);
  });

  it('getIntent returns null on 404 (HttpClient throws RailForgeError)', async () => {
    const err = Object.assign(new Error('Not found'), { status: 404 });
    http.get.mockRejectedValueOnce(err);
    const res = await x402.getIntent('x402_intent_00000000000000000000000000');
    expect(res).toBeNull();
  });

  it('getIntent rethrows non-404 errors', async () => {
    const err = Object.assign(new Error('boom'), { status: 500 });
    http.get.mockRejectedValueOnce(err);
    await expect(x402.getIntent(INTENT_ID)).rejects.toThrow(/boom/);
  });

  it('routes.create POSTs to /v1/x402/routes', async () => {
    const params = {
      path_pattern: '/echo',
      payee_address: PAYEE,
      asset: 'XRP',
      amount: '10000',
    };
    await x402.routes.create(params);
    expect(http.post).toHaveBeenCalledWith('/v1/x402/routes', params, undefined);
  });

  it('routes.create forwards idempotencyKey', async () => {
    const params = {
      path_pattern: '/echo',
      payee_address: PAYEE,
      asset: 'XRP',
      amount: '10000',
    };
    await x402.routes.create(params, { idempotencyKey: 'r-1' });
    expect(http.post).toHaveBeenCalledWith('/v1/x402/routes', params, 'r-1');
  });

  it('routes.list GETs /v1/x402/routes', async () => {
    await x402.routes.list();
    expect(http.get).toHaveBeenCalledWith('/v1/x402/routes');
  });

  it('routes.delete DELETEs /v1/x402/routes/:id', async () => {
    await x402.routes.delete('r-1');
    expect(http.delete).toHaveBeenCalledWith('/v1/x402/routes/r-1', undefined, undefined);
  });

  it('routes.delete forwards idempotencyKey', async () => {
    await x402.routes.delete('r-1', { idempotencyKey: 'idem-1' });
    expect(http.delete).toHaveBeenCalledWith('/v1/x402/routes/r-1', undefined, 'idem-1');
  });
});
