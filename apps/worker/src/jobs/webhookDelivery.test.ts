// Unit tests for webhookDelivery.ts.
//
// Coverage:
//   1. Happy path 200: HMAC signature header set correctly, row marked delivered
//   2. Skip path: row already 'delivered' → no fetch, no update
//   3. Endpoint missing → marked failed without fetch
//   4. Endpoint inactive → marked failed without fetch
//   5. 4xx (not 429) → marked failed (no retry)
//   6. 5xx → throws WebhookDeliveryRetryable, attempts bumped
//   7. 429 → throws WebhookDeliveryRetryable, attempts bumped
//   8. Network error → throws WebhookDeliveryRetryable
//   9. Last attempt of retryable failure → marked failed, does NOT throw
//   10. signWebhookPayload pure-function: deterministic + secret-dependent

import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookDeliveryJobData } from '../queues.ts';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbUpdateCalls: Array<{ table: string; set: unknown }> = [];
const deliverySelectResult = {
  current: [
    {
      id: 'del-1',
      eventType: 'transaction.validated',
      payload: { foo: 'bar' },
      status: 'pending',
    },
  ] as unknown[],
};
const endpointSelectResult = {
  current: [
    {
      id: 'ep-1',
      url: 'https://hook.example/webhook',
      secret: 'whsec_test_secret',
      isActive: true,
    },
  ] as unknown[],
};
// Toggle which select branch we're returning. The worker calls
// db.select() twice in order: deliveries first, then endpoints. We track
// call order via a counter.
const selectCallOrder = { count: 0 };

vi.mock('@railforge/db', () => {
  const update = vi.fn((table: { __name: string }) => ({
    set: vi.fn((payload: unknown) => ({
      where: vi.fn(() => {
        dbUpdateCalls.push({ table: table.__name, set: payload });
        return Promise.resolve();
      }),
    })),
  }));
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          // First call → deliveries, second call → endpoints.
          // Reset on each test via beforeEach.
          const idx = selectCallOrder.count++;
          if (idx === 0) return deliverySelectResult.current;
          return endpointSelectResult.current;
        }),
      })),
    })),
  }));
  return {
    db: { update, select },
    schema: {
      webhookDeliveries: {
        __name: 'webhook_deliveries',
        id: 'id',
        eventType: 'eventType',
        payload: 'payload',
        status: 'status',
      },
      webhookEndpoints: {
        __name: 'webhook_endpoints',
        id: 'id',
        url: 'url',
        secret: 'secret',
        isActive: 'isActive',
      },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  };
});

// ── queues mock — only the type re-export is used by the file ──────────────

vi.mock('../queues.ts', () => ({
  WEBHOOK_DELIVERY_QUEUE: 'railforge-webhook-delivery',
}));

// ── DNS mock for the SSRF guard (#18) ──────────────────────────────────────
//
// The SSRF guard added in Sprint 7 calls `dns.lookup()` before every
// fetch. Without a mock, tests using made-up hostnames like
// `hook.example` would hit real DNS and fail. We mock a default "safe
// public IP" response and let individual tests override it per-case.
// Typed loosely so tests can mockResolvedValueOnce with either family=4
// or family=6 without fighting a `4 as const` literal type.
const dnsLookupMock = vi.fn<(hostname: string) => Promise<{ address: string; family: 4 | 6 }>>(
  async (_hostname: string) => ({
    address: '93.184.216.34', // a known public IP (example.com)
    family: 4,
  }),
);
vi.mock('node:dns/promises', () => ({
  lookup: (hostname: string) => dnsLookupMock(hostname),
}));

// ── fetch mock ──────────────────────────────────────────────────────────────

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Import AFTER mocks.
const { processWebhookDeliveryJob, signWebhookPayload, WebhookDeliveryRetryable } = await import(
  './webhookDelivery.ts'
);

// ── Test helpers ────────────────────────────────────────────────────────────

function makeJob(
  data: WebhookDeliveryJobData,
  attemptsMade = 0,
  attempts = 5,
): Job<WebhookDeliveryJobData> {
  return {
    data,
    id: 'job-1',
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<WebhookDeliveryJobData>;
}

const BASE_JOB_DATA: WebhookDeliveryJobData = {
  deliveryId: 'del-1',
  endpointId: 'ep-1',
};

function makeFetchResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
  } as unknown as Response;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('signWebhookPayload', () => {
  it('produces a deterministic 64-char hex digest', () => {
    const sig = signWebhookPayload('whsec_test', '{"a":1}');
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    // Same inputs → same signature.
    expect(signWebhookPayload('whsec_test', '{"a":1}')).toBe(sig);
  });

  it('different secrets produce different signatures (even with same body)', () => {
    const sig1 = signWebhookPayload('whsec_one', '{"a":1}');
    const sig2 = signWebhookPayload('whsec_two', '{"a":1}');
    expect(sig1).not.toBe(sig2);
  });

  it('different bodies produce different signatures (even with same secret)', () => {
    const sig1 = signWebhookPayload('whsec_test', '{"a":1}');
    const sig2 = signWebhookPayload('whsec_test', '{"a":2}');
    expect(sig1).not.toBe(sig2);
  });
});

describe('processWebhookDeliveryJob', () => {
  beforeEach(() => {
    dbUpdateCalls.length = 0;
    selectCallOrder.count = 0;
    deliverySelectResult.current = [
      {
        id: 'del-1',
        eventType: 'transaction.validated',
        payload: { foo: 'bar' },
        status: 'pending',
      },
    ];
    endpointSelectResult.current = [
      {
        id: 'ep-1',
        url: 'https://hook.example/webhook',
        secret: 'whsec_test_secret',
        isActive: true,
      },
    ];
    fetchMock.mockReset();
    // Reset the DNS mock to the default "safe public IP" so each test
    // starts from a clean baseline. Individual tests may override it to
    // simulate DNS rebinding or NXDOMAIN.
    dnsLookupMock.mockReset();
    dnsLookupMock.mockImplementation(async () => ({
      address: '93.184.216.34',
      family: 4,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path 200: signs payload, POSTs with correct headers, marks delivered', async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(200));

    await processWebhookDeliveryJob(makeJob(BASE_JOB_DATA));

    // fetch called once with the right shape.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hook.example/webhook');
    expect(init.method).toBe('POST');

    // Headers: signature, content-type, user-agent.
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toMatch(/^RailForge-Webhooks/);
    expect(headers['X-RailForge-Signature']).toMatch(/^[a-f0-9]{64}$/);

    // The signature must match what signWebhookPayload would produce on the
    // exact body bytes. CRITICAL: re-serializing parsed JSON would produce a
    // different signature than what we sent on the wire.
    const sentBody = init.body as string;
    expect(headers['X-RailForge-Signature']).toBe(
      signWebhookPayload('whsec_test_secret', sentBody),
    );

    // Payload shape matches the public webhook envelope.
    const parsed = JSON.parse(sentBody) as {
      id: string;
      type: string;
      data: unknown;
    };
    expect(parsed.id).toBe('del-1');
    expect(parsed.type).toBe('transaction.validated');
    expect(parsed.data).toEqual({ foo: 'bar' });

    // DB row marked delivered with the response code.
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('delivered');
    expect(update.responseCode).toBe(200);
    expect(update.attempts).toBe(1);
  });

  it('skip: row already delivered → no fetch, no update', async () => {
    deliverySelectResult.current = [
      {
        id: 'del-1',
        eventType: 'transaction.validated',
        payload: { foo: 'bar' },
        status: 'delivered',
      },
    ];

    await processWebhookDeliveryJob(makeJob(BASE_JOB_DATA));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it('endpoint missing → marks failed without fetching', async () => {
    endpointSelectResult.current = [];

    await processWebhookDeliveryJob(makeJob(BASE_JOB_DATA));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
  });

  it('endpoint inactive → marks failed without fetching', async () => {
    endpointSelectResult.current = [
      {
        id: 'ep-1',
        url: 'https://hook.example/webhook',
        secret: 'whsec_test',
        isActive: false,
      },
    ];

    await processWebhookDeliveryJob(makeJob(BASE_JOB_DATA));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbUpdateCalls).toHaveLength(1);
    expect((dbUpdateCalls[0]!.set as Record<string, unknown>).status).toBe('failed');
  });

  it('4xx (not 429): marks failed permanently, does NOT throw', async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(400));

    await expect(processWebhookDeliveryJob(makeJob(BASE_JOB_DATA))).resolves.toBeUndefined();

    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.responseCode).toBe(400);
  });

  it('5xx with attempts left: throws WebhookDeliveryRetryable, bumps attempts', async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(503));

    await expect(processWebhookDeliveryJob(makeJob(BASE_JOB_DATA, 0, 5))).rejects.toThrow(
      WebhookDeliveryRetryable,
    );

    // The DB row should reflect the attempt count, NOT 'failed' yet.
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBeUndefined(); // bumpAttempt doesn't set status
    expect(update.attempts).toBe(1);
    expect(update.responseCode).toBe(503);
  });

  it('429 with attempts left: throws WebhookDeliveryRetryable', async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(429));

    await expect(processWebhookDeliveryJob(makeJob(BASE_JOB_DATA, 0, 5))).rejects.toThrow(
      WebhookDeliveryRetryable,
    );
  });

  it('network error with attempts left: throws WebhookDeliveryRetryable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(processWebhookDeliveryJob(makeJob(BASE_JOB_DATA, 0, 5))).rejects.toThrow(
      WebhookDeliveryRetryable,
    );
  });

  it('last attempt of a 5xx: marks failed, does NOT throw (no retry would happen)', async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(503));

    // attemptsMade=4, attempts=5 → this is attempt 5/5, the last one.
    await expect(processWebhookDeliveryJob(makeJob(BASE_JOB_DATA, 4, 5))).resolves.toBeUndefined();

    const failedUpdate = dbUpdateCalls.find(
      (c) => (c.set as Record<string, unknown>).status === 'failed',
    );
    expect(failedUpdate).toBeDefined();
  });

  it('last attempt of a network error: marks failed, does NOT throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(processWebhookDeliveryJob(makeJob(BASE_JOB_DATA, 4, 5))).resolves.toBeUndefined();

    const failedUpdate = dbUpdateCalls.find(
      (c) => (c.set as Record<string, unknown>).status === 'failed',
    );
    expect(failedUpdate).toBeDefined();
  });

  // ── Sprint 7 #18: delivery-time SSRF guard ─────────────────────────────
  //
  // The webhook service already rejects private IPs at registration, but
  // a public-looking hostname can rebind to an internal IP between
  // registration and delivery. The guard in ssrfGuard.ts re-resolves and
  // re-validates at delivery time; these tests cover the blocked paths.

  describe('SSRF guard (#18)', () => {
    it('blocks delivery when hostname resolves to AWS metadata IP', async () => {
      // Simulate DNS rebinding: the registration-time hostname looks
      // public, but the live DNS answer is the AWS instance metadata
      // service at 169.254.169.254.
      dnsLookupMock.mockResolvedValueOnce({
        address: '169.254.169.254',
        family: 4,
      });

      await processWebhookDeliveryJob(makeJob(BASE_JOB_DATA));

      // fetch MUST NOT have been called — the guard rejected before the POST.
      expect(fetchMock).not.toHaveBeenCalled();
      // Delivery row marked failed permanently (not retryable).
      const failedUpdate = dbUpdateCalls.find(
        (c) => (c.set as Record<string, unknown>).status === 'failed',
      );
      expect(failedUpdate).toBeDefined();
    });

    it('blocks delivery when hostname resolves to RFC 1918 (10.0.0.1)', async () => {
      dnsLookupMock.mockResolvedValueOnce({
        address: '10.0.0.1',
        family: 4,
      });

      await processWebhookDeliveryJob(makeJob(BASE_JOB_DATA));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        dbUpdateCalls.find((c) => (c.set as Record<string, unknown>).status === 'failed'),
      ).toBeDefined();
    });

    it('blocks delivery when hostname resolves to loopback (127.0.0.1)', async () => {
      dnsLookupMock.mockResolvedValueOnce({
        address: '127.0.0.1',
        family: 4,
      });

      await processWebhookDeliveryJob(makeJob(BASE_JOB_DATA));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        dbUpdateCalls.find((c) => (c.set as Record<string, unknown>).status === 'failed'),
      ).toBeDefined();
    });

    it('blocks delivery when hostname resolves to IPv6 loopback (::1)', async () => {
      dnsLookupMock.mockResolvedValueOnce({
        address: '::1',
        family: 6,
      });

      await processWebhookDeliveryJob(makeJob(BASE_JOB_DATA));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        dbUpdateCalls.find((c) => (c.set as Record<string, unknown>).status === 'failed'),
      ).toBeDefined();
    });

    it('blocked delivery is NOT retried (does not throw WebhookDeliveryRetryable)', async () => {
      dnsLookupMock.mockResolvedValueOnce({
        address: '169.254.169.254',
        family: 4,
      });

      // If the guard threw a retryable error, BullMQ would cycle back and
      // hit the same blocked target again. It must resolve normally so
      // the job is marked done.
      await expect(processWebhookDeliveryJob(makeJob(BASE_JOB_DATA))).resolves.toBeUndefined();
    });

    it('DNS NXDOMAIN: treated as transient, throws WebhookDeliveryRetryable with attempts left', async () => {
      dnsLookupMock.mockRejectedValueOnce(
        Object.assign(new Error('getaddrinfo ENOTFOUND hook.example'), {
          code: 'ENOTFOUND',
        }),
      );

      // attemptsMade=0 → plenty of retries left. Guard rethrows as retryable.
      await expect(processWebhookDeliveryJob(makeJob(BASE_JOB_DATA, 0, 5))).rejects.toThrow(
        WebhookDeliveryRetryable,
      );

      // fetch not called (dns failed first), no status code to record.
      expect(fetchMock).not.toHaveBeenCalled();
      // attempts bumped but status NOT marked failed (retryable).
      const bump = dbUpdateCalls[0];
      expect(bump).toBeDefined();
      const set = bump!.set as Record<string, unknown>;
      expect(set.attempts).toBe(1);
      expect(set.status).toBeUndefined();
    });

    it('DNS NXDOMAIN on the last attempt: marks failed, does NOT throw', async () => {
      dnsLookupMock.mockRejectedValueOnce(
        Object.assign(new Error('getaddrinfo ENOTFOUND hook.example'), {
          code: 'ENOTFOUND',
        }),
      );

      // attemptsMade=4, attempts=5 → the 5th and final attempt.
      await expect(
        processWebhookDeliveryJob(makeJob(BASE_JOB_DATA, 4, 5)),
      ).resolves.toBeUndefined();

      expect(
        dbUpdateCalls.find((c) => (c.set as Record<string, unknown>).status === 'failed'),
      ).toBeDefined();
    });

    it('happy path: public IP passes through and fetch runs', async () => {
      // Default mock already returns 93.184.216.34 (public).
      fetchMock.mockResolvedValueOnce(makeFetchResponse(200));

      await processWebhookDeliveryJob(makeJob(BASE_JOB_DATA));

      expect(dnsLookupMock).toHaveBeenCalledWith('hook.example');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        dbUpdateCalls.find((c) => (c.set as Record<string, unknown>).status === 'delivered'),
      ).toBeDefined();
    });
  });
});
