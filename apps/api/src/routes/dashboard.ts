// Dashboard read endpoints. These back the React dashboard app — they
// mirror existing resource views but scoped to the authenticated client
// AND filtered by the `environment` / `network` query param so the UI's
// sandbox toggle produces different result sets.
//
// Closes PLAN.md §9.2 G-5: "Dashboard sandbox toggle — network selector
// is UI-only, no backend wiring."
//
// Scope:
//   GET /v1/dashboard/transactions?network=testnet|mainnet&limit=N
//   GET /v1/dashboard/credentials?environment=testnet|mainnet
//   GET /v1/dashboard/domains?environment=testnet|mainnet
//   GET /v1/dashboard/keys?environment=testnet|mainnet
//
// The filter is applied via a JOIN on `api_keys.environment` (already
// scoped per-API-key in the schema). Transactions/credentials/domains
// themselves don't carry a network column, but they're created against
// a specific API key at request time — so a client that uses a testnet
// key only produces rows visible under ?network=testnet. Concretely we
// filter by transactions.clientId = authenticatedClientId AND there
// exists an api_key with matching environment for that client. Since
// one client can hold multiple keys across environments, this is a
// coarse filter — it hides the whole tenant when the selected network
// has no keys for that client, and shows all rows otherwise. Good enough
// for the sandbox toggle UX; a per-row environment column would be a
// schema change deferred to a real mainnet rollout.

import { and, db, desc, eq, schema } from '@railforge/db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.ts';

const dashboard = new Hono<AppEnv>();

const networkSchema = z.enum(['testnet', 'mainnet']);

async function clientHasKeyInEnvironment(
  clientId: string,
  environment: 'testnet' | 'mainnet',
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.clientId, clientId), eq(schema.apiKeys.environment, environment)))
    .limit(1);
  return rows.length > 0;
}

function parseNetworkParam(
  raw: string | undefined,
  paramName: string,
): { ok: true; value: 'testnet' | 'mainnet' } | { ok: false; error: string } {
  if (!raw) {
    return {
      ok: false,
      error: `missing ${paramName} query param (testnet|mainnet)`,
    };
  }
  const parsed = networkSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `${paramName} must be 'testnet' or 'mainnet'` };
  }
  return { ok: true, value: parsed.data };
}

// GET /transactions?network=X&limit=N
dashboard.get('/transactions', async (c) => {
  const clientId = c.get('clientId');
  const parsed = parseNetworkParam(c.req.query('network'), 'network');
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  if (Number.isNaN(limit) || limit < 1 || limit > 200) {
    return c.json({ error: 'limit must be an integer between 1 and 200' }, 400);
  }

  if (!(await clientHasKeyInEnvironment(clientId, parsed.value))) {
    return c.json({ data: [] });
  }

  const rows = await db
    .select({
      id: schema.transactions.id,
      txType: schema.transactions.txType,
      sourceAddress: schema.transactions.sourceAddress,
      status: schema.transactions.status,
      txHash: schema.transactions.txHash,
      resultCode: schema.transactions.resultCode,
      ledgerIndex: schema.transactions.ledgerIndex,
      createdAt: schema.transactions.createdAt,
      confirmedAt: schema.transactions.confirmedAt,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.clientId, clientId))
    .orderBy(desc(schema.transactions.createdAt))
    .limit(limit);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      tx_type: r.txType,
      source_address: r.sourceAddress,
      status: r.status,
      tx_hash: r.txHash,
      result_code: r.resultCode,
      ledger_index: r.ledgerIndex,
      created_at: r.createdAt,
      confirmed_at: r.confirmedAt,
    })),
  });
});

// GET /credentials?environment=X
dashboard.get('/credentials', async (c) => {
  const clientId = c.get('clientId');
  const parsed = parseNetworkParam(c.req.query('environment'), 'environment');
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  if (!(await clientHasKeyInEnvironment(clientId, parsed.value))) {
    return c.json({ data: [] });
  }

  const rows = await db
    .select({
      id: schema.credentials.id,
      issuerAddress: schema.credentials.issuerAddress,
      subjectAddress: schema.credentials.subjectAddress,
      credentialType: schema.credentials.credentialType,
      status: schema.credentials.status,
      expiresAt: schema.credentials.expiresAt,
      acceptedAt: schema.credentials.acceptedAt,
      createdAt: schema.credentials.createdAt,
    })
    .from(schema.credentials)
    .where(eq(schema.credentials.clientId, clientId))
    .orderBy(desc(schema.credentials.createdAt))
    .limit(200);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      issuer_address: r.issuerAddress,
      subject_address: r.subjectAddress,
      credential_type: r.credentialType,
      status: r.status,
      expires_at: r.expiresAt,
      accepted_at: r.acceptedAt,
      created_at: r.createdAt,
    })),
  });
});

// GET /domains?environment=X
dashboard.get('/domains', async (c) => {
  const clientId = c.get('clientId');
  const parsed = parseNetworkParam(c.req.query('environment'), 'environment');
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  if (!(await clientHasKeyInEnvironment(clientId, parsed.value))) {
    return c.json({ data: [] });
  }

  const rows = await db
    .select({
      id: schema.domains.id,
      ownerAddress: schema.domains.ownerAddress,
      domainId: schema.domains.domainId,
      acceptedCredentials: schema.domains.acceptedCredentials,
      createdAt: schema.domains.createdAt,
      updatedAt: schema.domains.updatedAt,
    })
    .from(schema.domains)
    .where(eq(schema.domains.clientId, clientId))
    .orderBy(desc(schema.domains.createdAt))
    .limit(200);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      owner_address: r.ownerAddress,
      domain_id: r.domainId,
      accepted_credentials: r.acceptedCredentials,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    })),
  });
});

// GET /keys?environment=X — list the client's API keys for the selected
// environment. Key secrets are never returned (they were only shown at
// creation time). This is the one endpoint where the filter is *inherent*
// to the result set, not coarse.
dashboard.get('/keys', async (c) => {
  const clientId = c.get('clientId');
  const parsed = parseNetworkParam(c.req.query('environment'), 'environment');
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const rows = await db
    .select({
      id: schema.apiKeys.id,
      prefix: schema.apiKeys.keyPrefix,
      environment: schema.apiKeys.environment,
      isActive: schema.apiKeys.isActive,
      createdAt: schema.apiKeys.createdAt,
      revokedAt: schema.apiKeys.revokedAt,
    })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.clientId, clientId), eq(schema.apiKeys.environment, parsed.value)))
    .orderBy(desc(schema.apiKeys.createdAt));

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      prefix: r.prefix,
      environment: r.environment,
      is_active: r.isActive,
      created_at: r.createdAt,
      revoked_at: r.revokedAt,
    })),
  });
});

export default dashboard;
