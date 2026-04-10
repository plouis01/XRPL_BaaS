// Unit tests for credentialExpiry.ts (Sprint 5).

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbSelectResults = { current: [] as unknown[] };
const dbInsertCalls: Array<{ table: string; values: unknown }> = [];

vi.mock('@railforge/db', () => {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => dbSelectResults.current),
    })),
  }));

  const insert = vi.fn((table: { __name: string }) => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ table: table.__name, values: v });
        return [{ id: `delivery-${dbInsertCalls.length}` }];
      }),
    })),
  }));

  return {
    db: { select, insert },
    eq: vi.fn(),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    schema: {
      credentials: { __name: 'credentials' },
      webhookEndpoints: { __name: 'webhook_endpoints' },
      webhookDeliveries: { __name: 'webhook_deliveries' },
    },
  };
});

// ── queue mock ──────────────────────────────────────────────────────────────

const enqueuedDeliveries: unknown[] = [];

vi.mock('../queues.ts', () => ({
  enqueueWebhookDelivery: vi.fn(async (data: unknown) => {
    enqueuedDeliveries.push(data);
  }),
}));

vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  },
}));

// ── Tests ───────────────────────────────────────────────────────────────────

let processCredentialExpirySweep: (horizonDays?: number) => Promise<{ alertedCount: number }>;

beforeEach(async () => {
  vi.resetModules();
  dbSelectResults.current = [];
  dbInsertCalls.length = 0;
  enqueuedDeliveries.length = 0;
  const mod = await import('./credentialExpiry.ts');
  processCredentialExpirySweep = mod.processCredentialExpirySweep;
});

describe('processCredentialExpirySweep', () => {
  it('returns alertedCount=0 when no credentials are expiring', async () => {
    dbSelectResults.current = [];
    const result = await processCredentialExpirySweep(7);
    expect(result.alertedCount).toBe(0);
  });

  it('alerts on credentials expiring within the horizon', async () => {
    const inThreeDays = new Date();
    inThreeDays.setDate(inThreeDays.getDate() + 3);

    // First select: credentials with status='accepted'
    // Second select: webhook endpoints for that client
    let selectCallCount = 0;
    const { db } = await import('@railforge/db');
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: vi.fn(() => ({
            where: vi.fn(async () => {
              selectCallCount++;
              if (selectCallCount === 1) {
                // Return expiring credential
                return [
                  {
                    id: 'cred-1',
                    clientId: 'client-1',
                    subjectAddress: 'rSubject',
                    issuerAddress: 'rIssuer',
                    credentialType: '4B5943',
                    expiresAt: inThreeDays,
                  },
                ];
              }
              // Return webhook endpoint subscribed to credential.expiring
              return [
                {
                  id: 'ep-1',
                  events: ['credential.expiring'],
                },
              ];
            }),
          })),
        }) as never,
    );

    const result = await processCredentialExpirySweep(7);
    expect(result.alertedCount).toBe(1);
    expect(enqueuedDeliveries).toHaveLength(1);
    expect(dbInsertCalls).toHaveLength(1);
    expect(dbInsertCalls[0]!.table).toBe('webhook_deliveries');
  });

  it('skips endpoints not subscribed to credential.expiring', async () => {
    const inThreeDays = new Date();
    inThreeDays.setDate(inThreeDays.getDate() + 3);

    let selectCallCount = 0;
    const { db } = await import('@railforge/db');
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: vi.fn(() => ({
            where: vi.fn(async () => {
              selectCallCount++;
              if (selectCallCount === 1) {
                return [
                  {
                    id: 'cred-1',
                    clientId: 'client-1',
                    subjectAddress: 'rSub',
                    issuerAddress: 'rIss',
                    credentialType: '4B5943',
                    expiresAt: inThreeDays,
                  },
                ];
              }
              // Endpoint only subscribes to transaction events
              return [{ id: 'ep-1', events: ['transaction.validated'] }];
            }),
          })),
        }) as never,
    );

    const result = await processCredentialExpirySweep(7);
    expect(result.alertedCount).toBe(0);
    expect(enqueuedDeliveries).toHaveLength(0);
  });
});
