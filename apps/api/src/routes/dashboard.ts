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
import { getXrpUsdRateCents } from '../services/priceOracle.service.ts';
import { getDailySpendUsage, resolvePolicy } from '../services/spendPolicy.service.ts';
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

// GET /transactions/:id — single-tx lookup scoped to the authenticated
// client. Used by the dashboard Tokens page to poll for the on-ledger
// outcome of an action it just queued (202 gives you a tx_id; this lets
// the UI show validated/failed + result_code without reloading the
// whole list).
dashboard.get('/transactions/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  // UUID v4 shape check — prevents malformed ids from reaching Drizzle
  // (Postgres would otherwise throw on an invalid uuid cast).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.json({ error: 'invalid transaction id' }, 400);
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
    .where(and(eq(schema.transactions.id, id), eq(schema.transactions.clientId, clientId)))
    .limit(1);

  const r = rows[0];
  if (!r) return c.json({ error: 'Transaction not found' }, 404);
  return c.json({
    id: r.id,
    tx_type: r.txType,
    source_address: r.sourceAddress,
    status: r.status,
    tx_hash: r.txHash,
    result_code: r.resultCode,
    ledger_index: r.ledgerIndex,
    created_at: r.createdAt,
    confirmed_at: r.confirmedAt,
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

// GET /accounts?environment=X — list the client's managed XRPL accounts.
// Powers the "New token" form's issuer dropdown. Same coarse env gate as
// tokens/credentials: `accounts` has no environment column (an account is
// the same address regardless of which API-key-scoped env you view it
// through), so we only confirm the caller has a key in the selected env
// before exposing the full account list.
dashboard.get('/accounts', async (c) => {
  const clientId = c.get('clientId');
  const parsed = parseNetworkParam(c.req.query('environment'), 'environment');
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  if (!(await clientHasKeyInEnvironment(clientId, parsed.value))) {
    return c.json({ data: [] });
  }

  // Filter out agent-mode accounts: agents are stored as `accounts` rows so
  // the worker can load their signing key, but they're NOT on-ledger funded
  // accounts — their reserve sits on the real parent. Surfacing them in
  // dropdowns that pick a "parent" or "issuer" leads users to provision
  // agents on top of agents (rejected by `resolveOwnedFundedAccount` in
  // agent.service, but the UX is bad). Detect them via `metadata.agent_of`,
  // which is set at agent-creation time. We pull metadata and filter in JS
  // because Drizzle's jsonb operators are awkward to use cross-version.
  const rows = await db
    .select({
      id: schema.accounts.id,
      address: schema.accounts.address,
      label: schema.accounts.label,
      custodyMode: schema.accounts.custodyMode,
      isFunded: schema.accounts.isFunded,
      metadata: schema.accounts.metadata,
      createdAt: schema.accounts.createdAt,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.clientId, clientId))
    .orderBy(desc(schema.accounts.createdAt))
    .limit(200);

  const isAgentMode = (m: unknown): boolean => {
    if (!m || typeof m !== 'object') return false;
    const v = (m as { agent_of?: unknown }).agent_of;
    return typeof v === 'string' && v.length > 0;
  };

  return c.json({
    data: rows
      .filter((r) => !isAgentMode(r.metadata))
      .map((r) => ({
        id: r.id,
        address: r.address,
        label: r.label,
        custody_mode: r.custodyMode,
        is_funded: r.isFunded ?? false,
        created_at: r.createdAt,
      })),
  });
});

// GET /agents?environment=X — list the client's agents (powers the
// dashboard Agents page). Same coarse env gate as /tokens, /credentials,
// /domains: agents have no environment column (binding lives on the
// api_keys row), so we confirm the caller has a key in the selected env
// before returning the full agent list.
//
// Shape mirrors the public GET /v1/agents route from agents.ts but joins
// to accounts so the parent classic address is in the response (avoids a
// per-row hop for the dashboard). Allowlist + spend_policy are loaded
// per-row to match the SDK contract.
dashboard.get('/agents', async (c) => {
  const clientId = c.get('clientId');
  const parsed = parseNetworkParam(c.req.query('environment'), 'environment');
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  if (!(await clientHasKeyInEnvironment(clientId, parsed.value))) {
    return c.json({ data: [] });
  }

  const rows = await db
    .select({
      id: schema.agents.id,
      preset: schema.agents.preset,
      parentAddress: schema.accounts.address,
      agentAddress: schema.agents.agentAddress,
      label: schema.agents.label,
      status: schema.agents.status,
      pendingRevocation: schema.agents.pendingRevocation,
      createdAt: schema.agents.createdAt,
    })
    .from(schema.agents)
    .innerJoin(schema.accounts, eq(schema.agents.parentAccountId, schema.accounts.id))
    .where(eq(schema.agents.clientId, clientId))
    .orderBy(desc(schema.agents.createdAt))
    .limit(200);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      preset: r.preset,
      parent_address: r.parentAddress,
      agent_address: r.agentAddress,
      label: r.label,
      status: r.status,
      // pending_revocation: true while a DELETE /v1/agents/:id has queued
      // a SignerListSet that hasn't yet validated. UI surfaces this as
      // "Revoking…" until the txConfirmer flips status to 'revoked' (or
      // clears the flag on failure, leaving status='active').
      pending_revocation: r.pendingRevocation,
      created_at: r.createdAt,
      // agent_seed deliberately absent; allowlist + spend_policy are
      // available via the public GET /v1/agents/:id endpoint when the
      // dashboard expands a row.
    })),
  });
});

// GET /agents/:id/transactions?limit=N — per-agent tx history. Filters by
// transactions.agent_id (set in payment.service when ctx.agentId is
// non-null) AND clientId for tenant isolation. Two-clause WHERE rather
// than a JOIN through agents because the agent_id column itself already
// proves origin — the clientId clause is just the standard cross-tenant
// safety check.
dashboard.get('/agents/:id/transactions', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.json({ error: 'invalid agent id' }, 400);
  }

  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  if (Number.isNaN(limit) || limit < 1 || limit > 200) {
    return c.json({ error: 'limit must be an integer between 1 and 200' }, 400);
  }

  // Confirm the agent belongs to the caller before returning rows. Skipping
  // this would still be safe (the agent_id+clientId WHERE produces an
  // empty set for cross-tenant ids) but a 404 is the clearer signal.
  const agentRows = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, id), eq(schema.agents.clientId, clientId)))
    .limit(1);
  if (agentRows.length === 0) {
    return c.json({ error: 'Agent not found' }, 404);
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
      amountDrops: schema.transactions.amountDrops,
      createdAt: schema.transactions.createdAt,
      confirmedAt: schema.transactions.confirmedAt,
    })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.clientId, clientId), eq(schema.transactions.agentId, id)))
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
      amount_drops: r.amountDrops,
      created_at: r.createdAt,
      confirmed_at: r.confirmedAt,
    })),
  });
});

// GET /agents/:id/usage — resolved XRP spend vs caps for this agent.
// Resolution prefers a per-agent row in spend_policies; falls back to
// the tenant-wide default (agent_id IS NULL) when no override exists.
// `scope` reflects which row resolved: 'agent' = per-agent override,
// 'client' = inherited tenant default, 'unlimited' = neither row active.
// The Redis counter we read matches the resolved scope, so an inheriting
// agent shows the tenant counter and an overridden agent shows its own.
dashboard.get('/agents/:id/usage', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.json({ error: 'invalid agent id' }, 400);
  }

  // Tenant-scoped ownership check before exposing anything — prevents a
  // cross-tenant id from probing the existence of another client's agent.
  const agentRows = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, id), eq(schema.agents.clientId, clientId)))
    .limit(1);
  if (agentRows.length === 0) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const policy = await resolvePolicy(clientId, id);
  const counterAgentId = policy.scope === 'agent' ? id : null;
  // Counter is now denominated in USD cents (migration 0019). The XRP
  // rate metadata lets the dashboard show the user what conversion rate
  // is being applied to XRP txs and how stale the price feed is.
  const [dailyUsedCents, xrpRate] = await Promise.all([
    getDailySpendUsage(clientId, counterAgentId),
    getXrpUsdRateCents(),
  ]);

  return c.json({
    daily_used_usd_cents: dailyUsedCents,
    daily_limit_usd_cents:
      policy.dailyLimitUsdCents !== null ? policy.dailyLimitUsdCents.toString() : null,
    max_per_tx_usd_cents:
      policy.maxPerTxUsdCents !== null ? policy.maxPerTxUsdCents.toString() : null,
    scope: policy.scope,
    xrp_usd_rate: {
      cents: xrpRate.cents,
      source: xrpRate.source,
      fetched_at: new Date(xrpRate.fetchedAt).toISOString(),
    },
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
      agentId: schema.apiKeys.agentId,
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
      agent_id: r.agentId,
    })),
  });
});

// POST /keys — create a new API key for the authenticated client. The
// key plaintext is returned ONCE in this response; the server only
// stores the HMAC-SHA256(pepper, key). The dashboard must copy it out
// immediately — there is no recovery path if the client loses it.
//
// Body: { environment, label?, agent_id? }.
//
// agent_id (optional): bind the new key to an existing agent. The auth
// middleware reads `api_keys.agent_id` and sets `c.get('agentId')`, which
// the agent-scope middleware (requireNotAgent) and payment.service
// (authorizeAgentPayment) gate against. Without a binding, agents are
// provisioned but unusable — there's no key that resolves to them.
const createKeySchema = z.object({
  environment: networkSchema,
  label: z.string().min(1).max(200).optional(),
  agent_id: z.string().uuid().optional(),
});

dashboard.post('/keys', async (c) => {
  const clientId = c.get('clientId');
  const callerEnv = c.get('environment');

  // Defense-in-depth (REVIEW A1): the global v1.use('/dashboard/*',
  // requireNotAgent) gate already refuses agent-bound callers before this
  // handler runs. The inline check is a second lock against a future
  // refactor that re-mounts dashboard outside /v1 or accidentally drops
  // the global guard — a regression here would re-open the privilege-
  // escalation path (mint a non-bound key, escape agent scope).
  if (c.get('agentId')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  let body: {
    environment: 'testnet' | 'mainnet';
    label?: string;
    agent_id?: string;
  };
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

  // Optional agent binding: validate the agent exists, belongs to this
  // client, and isn't revoked. Cross-tenant resolution is done at the SQL
  // level via the (id, clientId) predicate — a row owned by another tenant
  // returns no match and surfaces as "agent not found".
  //
  // Status check: 'pending' agents are bindable on purpose so the caller
  // can mint a key while the SignerListSet is still validating; the
  // service-layer authorizeAgentPayment gate will reject payments until
  // the txConfirmer flips status to 'active'. 'revoked' (future state) is
  // explicitly rejected so a stale binding can't resurrect a key.
  if (body.agent_id) {
    const agentRows = await db
      .select({
        id: schema.agents.id,
        status: schema.agents.status,
      })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, body.agent_id), eq(schema.agents.clientId, clientId)))
      .limit(1);
    const agent = agentRows[0];
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    if (agent.status === 'revoked' || agent.status === 'failed') {
      return c.json({ error: `Cannot bind a key to an agent in status '${agent.status}'` }, 409);
    }
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
      agentId: body.agent_id ?? null,
    })
    .returning({
      id: schema.apiKeys.id,
      prefix: schema.apiKeys.keyPrefix,
      environment: schema.apiKeys.environment,
      isActive: schema.apiKeys.isActive,
      createdAt: schema.apiKeys.createdAt,
      agentId: schema.apiKeys.agentId,
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
      agent_id: row.agentId,
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

  // Defense-in-depth (REVIEW A1) — see POST /keys for full rationale. An
  // agent-bound caller reaching this handler would be a tenant-wide DoS
  // (revoke any of the tenant's keys including the operator key).
  if (c.get('agentId')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

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
