// Webhook subscription service.
//
// Sprint 3 scope: register/list/delete endpoints. The endpoint secret is
// generated server-side at registration time and returned ONCE in the
// create response — clients must store it for HMAC verification later.
//
// Architecture notes:
//
// - The secret is stored verbatim in `webhook_endpoints.secret`. We do NOT
//   hash it the way we hash API keys — the worker needs the plaintext to
//   compute HMAC-SHA256 on every delivery, and HMAC requires the same key
//   on both ends. Hashing would prevent the worker from signing.
//
// - Listing endpoints does NOT include the secret. It's only returned at
//   creation time. To rotate, the client deletes the old endpoint and
//   creates a new one. (Sprint 4: rotate-secret endpoint.)
//
// - Cross-tenant isolation: every query is scoped by clientId. The
//   handler reads clientId from the auth context, never the request body.

import { randomBytes } from 'node:crypto';
import { and, db, eq, schema } from '@railforge/db';

const SECRET_PREFIX = 'whsec_';
// 32 random bytes → 43 base64url chars. Plus the prefix → 49-char secret.
const SECRET_BYTE_LENGTH = 32;

export interface CreateEndpointInput {
  clientId: string;
  url: string;
  events: string[];
}

export interface EndpointView {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: Date | null;
}

/**
 * The view returned by createEndpoint includes the secret EXACTLY ONCE.
 * The secret is never returned by listEndpoints or any other read path.
 */
export interface CreatedEndpointView extends EndpointView {
  /** Plaintext webhook secret. Returned ONLY at creation time. */
  secret: string;
}

export class WebhookServiceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_url',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookServiceError';
  }
}

/**
 * Generate a fresh webhook secret. Format: `whsec_<43 base64url chars>`.
 *
 * 32 bytes of randomness is the same strength as a fresh API key. The
 * `whsec_` prefix matches the Stripe convention so client-side libraries
 * have a recognizable token shape.
 */
function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(SECRET_BYTE_LENGTH).toString('base64url');
}

/**
 * Validate that a URL is suitable for webhook delivery. We require https
 * in production but permit http on localhost for dev. Reject everything
 * else (file://, javascript:, etc.) — those are an SSRF surface.
 */
function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookServiceError('invalid_url', 'Webhook URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new WebhookServiceError('invalid_url', 'Webhook URL must use http or https');
  }
  // Refuse http:// outside localhost — silent plaintext delivery is a
  // footgun. The worker doesn't enforce TLS itself, so this is the
  // chokepoint.
  if (
    parsed.protocol === 'http:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new WebhookServiceError('invalid_url', 'Webhook URL must use https except on localhost');
  }
  return parsed;
}

export async function createEndpoint(input: CreateEndpointInput): Promise<CreatedEndpointView> {
  validateUrl(input.url);

  const secret = generateSecret();
  const inserted = await db
    .insert(schema.webhookEndpoints)
    .values({
      clientId: input.clientId,
      url: input.url,
      secret,
      events: input.events,
      isActive: true,
    })
    .returning({
      id: schema.webhookEndpoints.id,
      url: schema.webhookEndpoints.url,
      events: schema.webhookEndpoints.events,
      isActive: schema.webhookEndpoints.isActive,
      createdAt: schema.webhookEndpoints.createdAt,
    });
  const row = inserted[0];
  if (!row) {
    throw new Error('webhook_endpoints insert returned no row');
  }

  return {
    id: row.id,
    url: row.url,
    events: row.events,
    isActive: row.isActive,
    createdAt: row.createdAt,
    secret, // ← only here. Never re-fetched on read paths.
  };
}

/**
 * List all webhook endpoints for a client. The secret is intentionally
 * NOT in the SELECT — it's never exposed after creation.
 */
export async function listEndpoints(clientId: string): Promise<EndpointView[]> {
  const rows = await db
    .select({
      id: schema.webhookEndpoints.id,
      url: schema.webhookEndpoints.url,
      events: schema.webhookEndpoints.events,
      isActive: schema.webhookEndpoints.isActive,
      createdAt: schema.webhookEndpoints.createdAt,
    })
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.clientId, clientId));
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    events: r.events,
    isActive: r.isActive,
    createdAt: r.createdAt,
  }));
}

/**
 * Hard delete an endpoint, scoped to the client. Returns true if a row
 * was actually removed; false if the id was unknown OR belonged to a
 * different client (the two cases are indistinguishable on purpose, no
 * cross-tenant enumeration).
 */
export async function deleteEndpoint(clientId: string, endpointId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.id, endpointId),
        eq(schema.webhookEndpoints.clientId, clientId),
      ),
    )
    .returning({ id: schema.webhookEndpoints.id });
  return deleted.length > 0;
}
