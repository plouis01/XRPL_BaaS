// Webhook subscription routes.
//
// POST   /v1/webhooks/endpoints              → register a new endpoint
// GET    /v1/webhooks/endpoints              → list endpoints (no secrets)
// DELETE /v1/webhooks/endpoints/:id          → delete an endpoint
//
// The plaintext secret is returned ONLY in the POST response. There is
// intentionally no GET-by-id route because exposing the secret on a read
// path would be a footgun. To rotate, delete and re-create.
//
// Middleware order (set in apps/api/src/index.ts):
//   ipRateLimit → auth → rateLimit → idempotency → this handler

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  WebhookServiceError,
  createEndpoint,
  deleteEndpoint,
  listEndpoints,
  rotateEndpointSecret,
} from '../services/webhook.service.ts';
import type { AppEnv } from '../types.ts';
import { createWebhookEndpointSchema } from '../validators/schemas.ts';

const webhooks = new Hono<AppEnv>();

// REVIEW.md LOW-03: revocationCheck is mounted globally on /v1 — no
// per-router duplicate.

webhooks.post('/endpoints', zValidator('json', createWebhookEndpointSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');

  try {
    const endpoint = await createEndpoint({
      clientId,
      url: body.url,
      events: body.events,
    });
    // Response shape mirrors the snake_case wire format used by other routes.
    // The `secret` field is here ONCE and never appears on any read path.
    return c.json(
      {
        id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        is_active: endpoint.isActive,
        secret: endpoint.secret,
        created_at: endpoint.createdAt,
      },
      201,
    );
  } catch (err) {
    if (err instanceof WebhookServiceError && err.code === 'invalid_url') {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

webhooks.get('/endpoints', async (c) => {
  const clientId = c.get('clientId');
  const endpoints = await listEndpoints(clientId);
  return c.json({
    data: endpoints.map((e) => ({
      id: e.id,
      url: e.url,
      events: e.events,
      is_active: e.isActive,
      created_at: e.createdAt,
    })),
  });
});

// POST /endpoints/:id/rotate-secret — REVIEW.md H-1. Generates a fresh
// whsec_ and returns it ONCE. The old secret is discarded; in-flight
// deliveries using the old secret will mismatch on the client's HMAC
// check. Clients must update their verification secret immediately.
webhooks.post('/endpoints/:id/rotate-secret', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  const result = await rotateEndpointSecret(clientId, id);
  if (!result) {
    // Same 404 treatment as DELETE — unknown id + wrong-tenant id are
    // indistinguishable on purpose.
    return c.json({ error: 'Webhook endpoint not found' }, 404);
  }
  return c.json({ id: result.id, secret: result.secret });
});

webhooks.delete('/endpoints/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  const removed = await deleteEndpoint(clientId, id);
  if (!removed) {
    // 404 covers both "doesn't exist" AND "belongs to a different client".
    // Indistinguishable on purpose — no cross-tenant enumeration.
    return c.json({ error: 'Webhook endpoint not found' }, 404);
  }
  return c.body(null, 204);
});

export default webhooks;
