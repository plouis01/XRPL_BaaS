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

import { randomBytes } from 'node:crypto';
import { and, db, desc, eq, schema } from '@railforge/db';
import { Hono } from 'hono';
import { z } from 'zod';
import { hashApiKey } from '../middleware/auth.ts';
import type { AppEnv } from '../types.ts';

const dashboard = new Hono<AppEnv>();

// REVIEW.md LOW-03: revocationCheck is mounted globally on /v1 in
// apps/api/src/index.ts — no per-router duplicate. Previously mounted
// here for REVIEW.md LOW-07 (dashboard mints API keys, so stolen-then-
// revoked keys must not survive the auth-cache window); the global
// mount covers that same surface.

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
      ledgerIndex: schema.credentials.ledgerIndex,
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
      ledger_index: r.ledgerIndex,
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

// GET /tokens?environment=X — list token issuances for the client. Joins
// tokens → accounts to surface the issuer classic address (the UI shows it,
// not the UUID). Same coarse env filter as credentials/domains.
dashboard.get('/tokens', async (c) => {
  const clientId = c.get('clientId');
  const parsed = parseNetworkParam(c.req.query('environment'), 'environment');
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  if (!(await clientHasKeyInEnvironment(clientId, parsed.value))) {
    return c.json({ data: [] });
  }

  const rows = await db
    .select({
      id: schema.tokens.id,
      issuerAddress: schema.accounts.address,
      tokenType: schema.tokens.tokenType,
      currencyCode: schema.tokens.currencyCode,
      mptIssuanceId: schema.tokens.mptIssuanceId,
      transferFee: schema.tokens.transferFee,
      clawback: schema.tokens.clawback,
      freezeEnabled: schema.tokens.freezeEnabled,
      maxSupply: schema.tokens.maxSupply,
      createdAt: schema.tokens.createdAt,
    })
    .from(schema.tokens)
    .innerJoin(schema.accounts, eq(schema.tokens.issuerAccount, schema.accounts.id))
    .where(eq(schema.tokens.clientId, clientId))
    .orderBy(desc(schema.tokens.createdAt))
    .limit(200);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      issuer_address: r.issuerAddress,
      token_type: r.tokenType,
      currency_code: r.currencyCode,
      mpt_issuance_id: r.mptIssuanceId,
      transfer_fee: r.transferFee ?? 0,
      clawback: r.clawback ?? false,
      freeze_enabled: r.freezeEnabled ?? false,
      max_supply: r.maxSupply,
      created_at: r.createdAt,
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

// POST /keys — create a new API key for the authenticated client. The
// key plaintext is returned ONCE in this response; the server only
// stores the HMAC-SHA256(pepper, key). The dashboard must copy it out
// immediately — there is no recovery path if the client loses it.
//
// Body: { environment: 'testnet' | 'mainnet', label?: string }.
// Rate limit: piggybacks on the per-client rateLimit middleware above.
const createKeySchema = z.object({
  environment: networkSchema,
  label: z.string().min(1).max(200).optional(),
});

dashboard.post('/keys', async (c) => {
  const clientId = c.get('clientId');
  const callerEnv = c.get('environment');

  let body: { environment: 'testnet' | 'mainnet'; label?: string };
  try {
    body = createKeySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'invalid request body' }, 400);
  }

  // REVIEW.md HIGH-02: privilege separation for key minting. Without this
  // check, a stolen testnet-scoped key could mint a brand-new mainnet key
  // and survive revocation of the original (different prefix, different id).
  //
  // Rule: the new key's environment must match the caller's. Cross-env
  // minting — especially testnet → mainnet — is the exact lateral-escalation
  // move the review flagged. A key holder who genuinely needs the other
  // environment must have obtained a key for that environment through the
  // normal onboarding path, not by calling this endpoint.
  if (body.environment !== callerEnv) {
    return c.json(
      {
        error: 'Forbidden',
        detail: `Cannot mint a ${body.environment} key from a ${callerEnv}-scoped API key. Authenticate with a ${body.environment} key to mint ${body.environment} keys.`,
      },
      403,
    );
  }

  // Wire format matches the existing `rf_<env>_<random>` convention used
  // across the codebase (see SETUP.md and k6 load-test env). 32 random
  // bytes → 43 base64url chars → ~258 bits of entropy. Prefix tag is
  // intentionally short ('test'/'live') to match existing keys.
  const envTag = body.environment === 'mainnet' ? 'live' : 'test';
  const rawKey = `rf_${envTag}_${randomBytes(32).toString('base64url')}`;
  const keyHash = hashApiKey(rawKey);
  // keyPrefix is the first N chars of the raw key, persisted for display
  // only. Matches the existing auth.ts KEY_PREFIX_LENGTH = 8.
  const keyPrefix = rawKey.slice(0, 8);

  const inserted = await db
    .insert(schema.apiKeys)
    .values({
      clientId,
      keyHash,
      keyPrefix,
      label: body.label ?? null,
      environment: body.environment,
      isActive: true,
    })
    .returning({
      id: schema.apiKeys.id,
      prefix: schema.apiKeys.keyPrefix,
      environment: schema.apiKeys.environment,
      isActive: schema.apiKeys.isActive,
      createdAt: schema.apiKeys.createdAt,
    });
  const row = inserted[0];
  if (!row) throw new Error('api_keys insert returned no row');

  return c.json(
    {
      id: row.id,
      prefix: row.prefix,
      environment: row.environment,
      is_active: row.isActive,
      created_at: row.createdAt,
      key: rawKey, // ← ONLY returned here. Never re-readable afterward.
    },
    201,
  );
});

// POST /keys/:id/revoke — flip is_active=false and stamp revoked_at.
// Idempotent: revoking an already-revoked key is a no-op 200.
dashboard.post('/keys/:id/revoke', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');

  const updated = await db
    .update(schema.apiKeys)
    .set({ isActive: false, revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.clientId, clientId)))
    .returning({ id: schema.apiKeys.id });
  if (updated.length === 0) {
    return c.json({ error: 'API key not found' }, 404);
  }
  return c.json({ id, revoked: true });
});

export default dashboard;
