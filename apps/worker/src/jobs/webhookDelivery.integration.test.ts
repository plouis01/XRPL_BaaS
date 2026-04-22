// Integration test: webhook delivery HMAC-SHA256 signature verification.
//
// Per CLAUDE.md testing rules: "Webhook tests must verify the HMAC-SHA256
// signature on the receiving side, not just that a POST was made."
//
// This test creates a real webhook_deliveries row, runs the delivery
// worker against a local HTTP server, and verifies that the
// X-RailForge-Signature header matches a manual HMAC-SHA256 recomputation
// of the received body using the endpoint's shared secret.
//
// GATING: self-skips unless RAILFORGE_TEST_NETWORK=testnet AND
// DATABASE_URL points at a reachable Postgres.

import { createHmac } from 'node:crypto';
import http from 'node:http';
import { db, eq, schema } from '@railforge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SHOULD_RUN = process.env.RAILFORGE_TEST_NETWORK === 'testnet' && !!process.env.DATABASE_URL;
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

let testClientId: string;
let webhookEndpointId: string;
let deliveryId: string;
const WEBHOOK_SECRET = 'whsec_integration_test_secret_42';
let capturedRequest: {
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  version: string | undefined;
} | null = null;
let server: http.Server;
let serverPort: number;

describeOrSkip('webhook delivery HMAC verification (real DB + local HTTP)', () => {
  beforeAll(async () => {
    // 1. Start a local HTTP server to receive the webhook.
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          capturedRequest = {
            body,
            signature: req.headers['x-railforge-signature'] as string | undefined,
            timestamp: req.headers['x-railforge-timestamp'] as string | undefined,
            version: req.headers['x-railforge-webhook-version'] as string | undefined,
          };
          res.writeHead(200);
          res.end('ok');
        });
      });
      server.listen(0, () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve();
      });
    });

    // 2. Create disposable DB rows.
    const suffix = Math.random().toString(36).slice(2, 10);
    const clientInserted = await db
      .insert(schema.clients)
      .values({
        name: 'webhook-hmac-test',
        email: `webhook-hmac-${suffix}@test.local`,
        plan: 'free',
      })
      .returning({ id: schema.clients.id });
    testClientId = clientInserted[0]!.id;

    const epInserted = await db
      .insert(schema.webhookEndpoints)
      .values({
        clientId: testClientId,
        url: `http://127.0.0.1:${serverPort}/webhook`,
        secret: WEBHOOK_SECRET,
        events: ['transaction.validated'],
        isActive: true,
      })
      .returning({ id: schema.webhookEndpoints.id });
    webhookEndpointId = epInserted[0]!.id;

    const delInserted = await db
      .insert(schema.webhookDeliveries)
      .values({
        endpointId: webhookEndpointId,
        eventType: 'transaction.validated',
        payload: { tx_id: 'test-tx', result_code: 'tesSUCCESS' },
        status: 'pending',
        attempts: 0,
      })
      .returning({ id: schema.webhookDeliveries.id });
    deliveryId = delInserted[0]!.id;
  }, 30_000);

  afterAll(async () => {
    server?.close();
    if (deliveryId)
      await db
        .delete(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.id, deliveryId))
        .catch(() => {});
    if (webhookEndpointId)
      await db
        .delete(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.id, webhookEndpointId))
        .catch(() => {});
    if (testClientId)
      await db
        .delete(schema.clients)
        .where(eq(schema.clients.id, testClientId))
        .catch(() => {});
    const { disconnectDb } = await import('@railforge/db');
    await disconnectDb().catch(() => {});
  }, 15_000);

  it('delivers webhook with correct HMAC-SHA256 signature', async () => {
    // Import the worker function directly — same as the unit tests do.
    const { processWebhookDeliveryJob } = await import('./webhookDelivery.ts');

    await processWebhookDeliveryJob({
      data: { deliveryId, endpointId: webhookEndpointId },
      id: 'hmac-int-1',
      attemptsMade: 0,
      opts: { attempts: 5 },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Job stub
    } as any);

    // The local server should have received the POST with all three v1
    // webhook headers (REVIEW.md MED-02 + LOW-18).
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.signature).toBeDefined();
    expect(capturedRequest!.timestamp).toBeDefined();
    expect(capturedRequest!.version).toBe('1');

    // Recompute HMAC-SHA256 over `timestamp + "." + body` (the v1 scheme)
    // and verify the signature matches. Body-only would be the legacy
    // pre-MED-02 scheme and is no longer accepted.
    const signingInput = `${capturedRequest!.timestamp}.${capturedRequest!.body}`;
    const expectedSignature = createHmac('sha256', WEBHOOK_SECRET)
      .update(signingInput)
      .digest('hex');
    expect(capturedRequest!.signature).toBe(expectedSignature);

    // Verify the body is valid JSON with the expected shape.
    const parsed = JSON.parse(capturedRequest!.body);
    expect(parsed.id).toBe(deliveryId);
    expect(parsed.type).toBe('transaction.validated');
    expect(parsed.data.tx_id).toBe('test-tx');

    // DB row should be marked delivered.
    const rows = await db
      .select({
        status: schema.webhookDeliveries.status,
        responseCode: schema.webhookDeliveries.responseCode,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, deliveryId))
      .limit(1);
    expect(rows[0]?.status).toBe('delivered');
    expect(rows[0]?.responseCode).toBe(200);
  }, 30_000);
});
