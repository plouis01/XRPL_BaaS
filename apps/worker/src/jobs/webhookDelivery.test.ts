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
});
