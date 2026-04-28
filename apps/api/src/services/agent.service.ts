// Agent service — VISION.md's "agent launcher" (POST /v1/agents).
//
// This is an ORCHESTRATOR, not a new XRPL primitive. Every on-ledger effect
// (funding payment, signer list, domain reference, spend policy row) is
// produced by composing existing services:
//
//   account.service    → creates the parent managed account (if not supplied)
//   permission.service → grants delegate signing authority (XLS-75 fallback)
//   spendPolicy.service (DB-writing side) → installs per-client caps
//   (agent_allowlists is written directly here — no standalone service yet)
//
// What "provisioning" means, step by step:
//
//   1. Validate preset + allowlist entry types against the preset
//   2. Resolve / use the parent managed account owned by the caller
//   3. Generate a delegate keypair locally (dev/test) — this will be swapped
//      for HSM generation once the HSM integration reaches Phase 2
//   4. Insert the `agents` row with status='pending' so the orphan reconciler
//      can clean up if step 5 fails
//   5. Call permission.service.grantPermission to enqueue the SignerListSet
//      tx that admits the delegate
//   6. Insert the agent_allowlists rows (atomic with the agent update)
//   7. Upsert the spend_policies row — override + preset defaults
//   8. Flip the agents row status='active' and record delegation_id
//
// The agent row stays 'pending' through step 5's enqueue — if the worker
// never processes the signer-list tx (Redis outage, worker crash), the
// delegate key never has on-ledger authority. That's the correct behavior:
// an 'active' agent without signing power on-ledger would be worse than
// none at all. Callers poll GET /v1/agents/:id to observe the flip, which
// the txConfirmer performs on tesSUCCESS of the grant tx.
//
// IMPORTANT: the delegate's SEED never leaves this process in a response or
// log line. It's returned EXACTLY ONCE in the provisioning response body so
// the caller can configure their agent runtime; after that it lives only in
// `accounts.master_key_ref` (same redaction path as parent-account seeds).

import { and, db, eq, isNull, schema } from '@railforge/db';
import { Wallet } from 'xrpl';
import { logger } from '../logger.ts';
import {
  AGENT_PRESETS,
  type AgentAllowlistEntryType,
  type AgentPresetName,
  getPreset,
} from '../presets/agent-presets.ts';
import { PermissionServiceError, grantPermission, revokePermission } from './permission.service.ts';

export class AgentServiceError extends Error {
  constructor(
    public readonly code:
      | 'invalid_preset'
      | 'parent_not_found'
      | 'parent_not_funded'
      | 'invalid_allowlist'
      | 'allowlist_required'
      | 'enqueue_failed'
      | 'db_conflict'
      // ── authorization failure codes (service-layer gating) ──────────────
      | 'agent_not_found'
      | 'agent_not_active'
      | 'source_not_parent'
      | 'destination_not_allowlisted'
      | 'token_not_allowlisted'
      // ── revocation codes ────────────────────────────────────────────────
      | 'agent_not_revocable'
      | 'agent_already_revoking'
      // ── parent eligibility ──────────────────────────────────────────────
      // The picked parent is itself an agent-mode account (has
      // metadata.agent_of set). Agents aren't on-ledger funded accounts —
      // their reserve sits on the real parent — so a SignerListSet from an
      // agent address rejects with actNotFound at rippled. Block at the
      // service layer; the dashboard /accounts list also filters them out.
      | 'parent_is_agent',
    message: string,
  ) {
    super(message);
    this.name = 'AgentServiceError';
  }
}

export interface AgentAllowlistInput {
  entry_type: AgentAllowlistEntryType;
  entry_value: string;
}

export interface ProvisionAgentInput {
  clientId: string;
  preset: AgentPresetName;
  parentAddress: string;
  label?: string;
  allowlist: AgentAllowlistInput[];
  spendPolicy?: {
    maxXrpPerTxDrops?: string | null;
    dailyXrpLimitDrops?: string | null;
  };
  quorum?: number;
  idempotencyKey?: string;
}

export interface AgentView {
  id: string;
  preset: string;
  parent_address: string;
  agent_address: string;
  label: string | null;
  status: string;
  /**
   * True while a DELETE /v1/agents/:id has queued a SignerListSet that
   * hasn't yet validated. The dashboard surfaces this as "Revoking…" so
   * the user sees the in-flight state — once the txConfirmer flips
   * status to 'revoked' (or clears the flag on failure) callers can
   * read the terminal state. Optional on the type so provisionAgent's
   * fresh-agent return value (always false) doesn't have to set it.
   */
  pending_revocation?: boolean;
  allowlist: AgentAllowlistInput[];
  spend_policy: {
    max_xrp_per_tx_drops: string | null;
    daily_xrp_limit_drops: string | null;
  };
  created_at: Date | null;
  /**
   * Delegate seed — returned EXACTLY ONCE in the provisioning response so
   * the caller can load it into their agent runtime. Never returned by GET
   * endpoints (getAgent / listAgents construct AgentView WITHOUT this
   * field). Redacted at the logger level; do not add it to log lines.
   */
  agent_seed?: string;
  /**
   * ID of the SignerListSet tx that grants the agent on-ledger authority.
   * Set on POST /agents response only. GET endpoints omit this (caller can
   * filter /transactions by type=SignerListSet + source=parent_address if
   * they need the tx).
   */
  grant_tx_id?: string;
}

// ── Allowlist validation ─────────────────────────────────────────────────────
// Each entry_value shape depends on its entry_type. Service-layer rather than
// Zod because the check is per-preset (a payment-agent can't pass 'domain'
// even if the validator accepted all three types generically).

const R_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
// MPT issuance ID: 192-bit = 48 hex chars. Domain ID: 256-bit = 64 hex.
const HEX_192 = /^[0-9a-fA-F]{48}$/;
const HEX_256 = /^[0-9a-fA-F]{64}$/;

function validateAllowlistEntry(
  preset: AgentPresetName,
  entry: AgentAllowlistInput,
): string | null {
  const presetDef = AGENT_PRESETS[preset];
  if (!presetDef.allowedEntryTypes.includes(entry.entry_type)) {
    return `preset '${preset}' does not allow entry_type '${entry.entry_type}'`;
  }
  switch (entry.entry_type) {
    case 'destination':
      if (!R_ADDRESS.test(entry.entry_value)) {
        return `destination '${entry.entry_value}' is not a valid XRPL address`;
      }
      return null;
    case 'token':
      // Either MPT issuance ID (48 hex) OR `<currency>:<issuer>` where
      // currency is 3 chars or 40-hex and issuer is an r-address.
      if (HEX_192.test(entry.entry_value)) return null;
      {
        const parts = entry.entry_value.split(':');
        if (parts.length !== 2) {
          return `token '${entry.entry_value}' must be an MPT issuance ID or '<currency>:<issuer>'`;
        }
        const [currency, issuer] = parts;
        const currencyOk =
          !!currency && (currency.length === 3 || /^[0-9a-fA-F]{40}$/.test(currency));
        const issuerOk = !!issuer && R_ADDRESS.test(issuer);
        if (!currencyOk || !issuerOk) {
          return `token '${entry.entry_value}' has an invalid currency or issuer`;
        }
      }
      return null;
    case 'domain':
      if (!HEX_256.test(entry.entry_value)) {
        return `domain '${entry.entry_value}' must be a 64-char hex DomainID`;
      }
      return null;
  }
}

// ── Parent account resolver ──────────────────────────────────────────────────

async function resolveOwnedFundedAccount(
  clientId: string,
  address: string,
): Promise<{ id: string; address: string } | null> {
  const rows = await db
    .select({
      id: schema.accounts.id,
      address: schema.accounts.address,
      isFunded: schema.accounts.isFunded,
      metadata: schema.accounts.metadata,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.clientId, clientId),
        eq(schema.accounts.address, address),
        isNull(schema.accounts.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Reject agent-mode accounts as parents. Agent rows are inserted into
  // accounts so the worker can load the delegate's signing key, but they
  // aren't on-ledger funded — their reserve sits on the REAL parent. A
  // SignerListSet from an agent address rejects with actNotFound at
  // rippled (the source has no ledger entry), and the txSubmitter leaves
  // the row stuck in 'submitting'. Refuse here so the user gets a clean
  // 400 instead of a silent stuck tx.
  const meta = (row.metadata ?? {}) as { agent_of?: unknown };
  if (typeof meta.agent_of === 'string' && meta.agent_of.length > 0) {
    throw new AgentServiceError(
      'parent_is_agent',
      'Parent address is itself an agent — pick a non-agent managed account as the parent',
    );
  }
  if (!row.isFunded) {
    throw new AgentServiceError(
      'parent_not_funded',
      'Parent account is not yet funded — wait for the funding payment to validate before provisioning an agent',
    );
  }
  return { id: row.id, address: row.address };
}

// ── Main provisioning flow ──────────────────────────────────────────────────

export async function provisionAgent(input: ProvisionAgentInput): Promise<AgentView> {
  const log = logger.child({
    service: 'agent',
    op: 'provision',
    clientId: input.clientId,
    preset: input.preset,
  });

  // 1. Preset + allowlist validation ------------------------------------------
  const preset = getPreset(input.preset);
  if (!preset) {
    throw new AgentServiceError('invalid_preset', `Unknown preset '${input.preset}'`);
  }

  if (preset.requireAllowlist && input.allowlist.length === 0) {
    throw new AgentServiceError(
      'allowlist_required',
      `preset '${preset.name}' requires at least one allowlist entry`,
    );
  }
  for (const entry of input.allowlist) {
    const err = validateAllowlistEntry(input.preset, entry);
    if (err) throw new AgentServiceError('invalid_allowlist', err);
  }

  // 2. Parent account resolution (cross-tenant safe) --------------------------
  const parent = await resolveOwnedFundedAccount(input.clientId, input.parentAddress);
  if (!parent) {
    throw new AgentServiceError('parent_not_found', 'Parent account not found');
  }

  // 3. Delegate keypair generation --------------------------------------------
  // DevSigner path; HSM-generated agent keys come with Phase 2. The seed is
  // stored as an accounts.master_key_ref on a new row so we can reconstruct
  // the Wallet on the worker side for future agent-signed txs. This mirrors
  // the semi-custodial model — the tenant gets the seed back once, and
  // RailForge retains a reference copy for signing.
  const delegateWallet = Wallet.generate();
  if (!delegateWallet.seed) {
    throw new Error('Wallet.generate() returned no seed — should never happen');
  }
  const agentAddress = delegateWallet.classicAddress;
  const agentSeed = delegateWallet.seed;

  // 4. Insert the agent row + the delegate accounts row atomically ------------
  // The delegate address is stored in `accounts` so that existing flows
  // (payment.service resolving source addresses, logger redaction of
  // master_key_ref) transparently cover it. The agents row joins to it via
  // delegate_account_id in a future migration; for now the link is via
  // unique agent_address + a FK on parent_account_id.
  // Resolve the spend-policy values up front so the upsert can run inside
  // the agents transaction (same atomic unit). Caller overrides win; any
  // field omitted falls back to the preset default. `null` is honored as
  // "explicitly disable this cap."
  const maxPerTx =
    input.spendPolicy?.maxXrpPerTxDrops === undefined
      ? preset.defaultSpendPolicy.maxXrpPerTxDrops
      : input.spendPolicy.maxXrpPerTxDrops;
  const dailyLimit =
    input.spendPolicy?.dailyXrpLimitDrops === undefined
      ? preset.defaultSpendPolicy.dailyXrpLimitDrops
      : input.spendPolicy.dailyXrpLimitDrops;

  let agentId: string;
  try {
    agentId = await db.transaction(async (tx) => {
      // Persist the delegate as a managed account so the worker can load
      // its key via the standard accounts lookup. custody_mode='semi'
      // because RailForge retains the seed; the tenant also has it.
      const acctInserted = await tx
        .insert(schema.accounts)
        .values({
          clientId: input.clientId,
          address: agentAddress,
          masterKeyRef: agentSeed,
          regularKey: null,
          custodyMode: 'semi',
          label: input.label ? `${input.label} (agent)` : `agent of ${parent.address}`,
          isFunded: true, // delegate doesn't need its own reserve; it signs for the parent
          reserveBalance: '0',
          metadata: { agent_of: parent.address, preset: input.preset },
        })
        .returning({ id: schema.accounts.id });
      if (!acctInserted[0]) {
        throw new AgentServiceError('db_conflict', 'accounts insert returned no row');
      }

      const agentInserted = await tx
        .insert(schema.agents)
        .values({
          clientId: input.clientId,
          parentAccountId: parent.id,
          agentAddress,
          delegationId: null,
          preset: input.preset,
          label: input.label ?? null,
          status: 'pending',
        })
        .returning({ id: schema.agents.id });
      const agentRow = agentInserted[0];
      if (!agentRow) {
        throw new AgentServiceError('db_conflict', 'agents insert returned no row');
      }

      if (input.allowlist.length > 0) {
        await tx.insert(schema.agentAllowlists).values(
          input.allowlist.map((e) => ({
            agentId: agentRow.id,
            entryType: e.entry_type,
            entryValue: e.entry_value,
          })),
        );
      }

      // Spend-policy upsert is FATAL and runs inside this transaction so a
      // failure rolls back the agents/accounts rows. Previously this was
      // wrapped in try/catch and non-fatal — that left a window where the
      // agent could flip to 'active' on-ledger but have no daily XRP cap,
      // silently degrading to "no policy" (security regression). Doing it
      // here, before grantPermission queues any on-ledger work, means a
      // failure leaves no SignerListSet in flight and no orphaned-active
      // agent on retry. VISION.md notes spend_policies grows a nullable
      // agent_id column in a later migration; until then, the policy is
      // installed at client scope.
      await tx
        .insert(schema.spendPolicies)
        .values({
          clientId: input.clientId,
          maxXrpPerTxDrops: maxPerTx,
          dailyXrpLimitDrops: dailyLimit,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: schema.spendPolicies.clientId,
          set: {
            maxXrpPerTxDrops: maxPerTx,
            dailyXrpLimitDrops: dailyLimit,
            isActive: true,
            updatedAt: new Date(),
          },
        });

      return agentRow.id;
    });
  } catch (err) {
    if (err instanceof AgentServiceError) throw err;
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new AgentServiceError('db_conflict', 'Agent address collision (retry)');
    }
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'agent provisioning transaction failed (rolled back, no on-ledger work)',
    );
    throw new AgentServiceError('db_conflict', 'Failed to persist agent state — please retry');
  }

  // 5. Grant the delegate on-ledger authority via permission.service ----------
  // This enqueues a SignerListSet (XLS-75 V1.1 fallback). The txConfirmer
  // will flip agents.status 'pending' → 'active' on tesSUCCESS (new hook
  // alongside the existing delegation confirmation — wired separately).
  let grantTxId: string;
  let delegationId: string;
  try {
    const grant = await grantPermission({
      clientId: input.clientId,
      delegatorAddress: parent.address,
      delegateAddress: agentAddress,
      permissions: [...preset.permissions],
      weight: 1,
      quorum: input.quorum ?? 1,
      idempotencyKey: input.idempotencyKey,
    });
    grantTxId = grant.tx_id;
    delegationId = grant.id;
  } catch (err) {
    if (err instanceof PermissionServiceError) {
      log.error({ err: err.message, code: err.code }, 'permission grant failed during provision');
      throw new AgentServiceError(
        err.code === 'enqueue_failed' ? 'enqueue_failed' : 'db_conflict',
        `Failed to grant delegate authority: ${err.message}`,
      );
    }
    throw err;
  }

  // 6. Back-fill delegation_id on the agents row ------------------------------
  // The spend-policy upsert was hoisted into the agents transaction above
  // (was step 7) so it can no longer leave the agent without a daily cap.
  await db.update(schema.agents).set({ delegationId }).where(eq(schema.agents.id, agentId));

  log.info({ agentId, parent: parent.address, grantTxId }, 'agent provisioned');

  return {
    id: agentId,
    preset: input.preset,
    parent_address: parent.address,
    agent_address: agentAddress,
    label: input.label ?? null,
    status: 'pending',
    allowlist: input.allowlist,
    spend_policy: {
      max_xrp_per_tx_drops: maxPerTx,
      daily_xrp_limit_drops: dailyLimit,
    },
    created_at: new Date(),
    agent_seed: agentSeed,
    grant_tx_id: grantTxId,
  };
}

// ── Authorization: called from payment.service / dex.service when the ───────
// auth middleware put an agentId on the context. This is the SERVICE-LAYER
// gate VISION.md §"Enforcement path" describes — the middleware chain (auth,
// revocationCheck, etc.) is generic across all clients, but deciding whether
// a given payment's destination / token is on this specific agent's allowlist
// needs the parsed body, which only the service has.
//
// Contract:
//   - agent exists for this clientId (cross-tenant defense)
//   - agent.status === 'active' (pending / failed / revoked → reject)
//   - source address IS the agent's parent account (an agent can't drain a
//     different managed account even if the API key technically auth'd)
//   - destination (rXXXX) is in agent_allowlists with entry_type='destination'
//   - if the tx moves a non-XRP asset, the token identifier is in
//     agent_allowlists with entry_type='token'
//
// Throws AgentServiceError on any rejection. The route's error response
// mapper translates each code to a 4xx.

export interface AuthorizePaymentInput {
  clientId: string;
  agentId: string;
  sourceAddress: string;
  destinationAddress: string;
  /**
   * Asset identifier if the payment is non-XRP. MPT payments pass the
   * 48-hex issuance id; issued-currency payments pass `<currency>:<issuer>`.
   * Omit (or null) for XRP-only payments — destination check still runs.
   */
  assetKey?: string | null;
}

interface AgentRowForAuth {
  id: string;
  status: string;
  parentAccountId: string;
  parentAddress: string;
}

async function loadAgentForAuth(
  clientId: string,
  agentId: string,
): Promise<AgentRowForAuth | null> {
  // Join agents → accounts to resolve parent address in a single round trip.
  // Scoped by clientId so a stolen agent_id from one tenant can't authorize
  // payments against another tenant's agents.
  const rows = await db
    .select({
      id: schema.agents.id,
      status: schema.agents.status,
      parentAccountId: schema.agents.parentAccountId,
      parentAddress: schema.accounts.address,
    })
    .from(schema.agents)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.agents.parentAccountId))
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.clientId, clientId)))
    .limit(1);
  return rows[0] ?? null;
}

async function isAllowlisted(
  agentId: string,
  entryType: AgentAllowlistEntryType,
  entryValue: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.agentAllowlists.id })
    .from(schema.agentAllowlists)
    .where(
      and(
        eq(schema.agentAllowlists.agentId, agentId),
        eq(schema.agentAllowlists.entryType, entryType),
        eq(schema.agentAllowlists.entryValue, entryValue),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function authorizeAgentPayment(input: AuthorizePaymentInput): Promise<void> {
  const log = logger.child({
    service: 'agent',
    op: 'authorizePayment',
    clientId: input.clientId,
    agentId: input.agentId,
  });

  const agent = await loadAgentForAuth(input.clientId, input.agentId);
  if (!agent) {
    // 404-style: no row OR wrong tenant — indistinguishable, on purpose.
    throw new AgentServiceError('agent_not_found', 'Agent not found');
  }
  if (agent.status !== 'active') {
    throw new AgentServiceError('agent_not_active', `Agent is not active (status=${agent.status})`);
  }
  if (agent.parentAddress !== input.sourceAddress) {
    // An agent key can sign for its parent account only. Anything else
    // is either a config error (agent bound to the wrong parent) or an
    // attempt to route a payment through a different managed account.
    throw new AgentServiceError('source_not_parent', 'Agent may only send from its parent account');
  }

  const destOk = await isAllowlisted(input.agentId, 'destination', input.destinationAddress);
  if (!destOk) {
    log.warn({ destination: input.destinationAddress }, 'destination not in agent allowlist');
    throw new AgentServiceError(
      'destination_not_allowlisted',
      `Destination ${input.destinationAddress} is not on the agent's allowlist`,
    );
  }

  if (input.assetKey) {
    const tokenOk = await isAllowlisted(input.agentId, 'token', input.assetKey);
    if (!tokenOk) {
      log.warn({ assetKey: input.assetKey }, 'token not in agent allowlist');
      throw new AgentServiceError(
        'token_not_allowlisted',
        `Token ${input.assetKey} is not on the agent's allowlist`,
      );
    }
  }
}

// ── Read endpoints (GET /v1/agents, GET /v1/agents/:id) ─────────────────────
// Both functions assemble an AgentView WITHOUT `agent_seed` and WITHOUT
// `grant_tx_id`. The seed contract is critical: the seed lives only in
// `accounts.master_key_ref` after provisioning and must never surface on a
// read path. The shape stays consistent with provisionAgent's response so
// the SDK can use one type.
//
// Spend policy is currently per-client (VISION.md notes a future migration
// adds an agent_id column). Both reads pull spend_policies by clientId; if
// no row exists, the agent surfaces with null caps — the same shape the
// preset would produce when both fields are explicitly disabled.

interface AgentJoinedRow {
  id: string;
  preset: string;
  parentAddress: string;
  agentAddress: string;
  label: string | null;
  status: string;
  pendingRevocation: boolean;
  createdAt: Date | null;
}

async function loadAllowlist(agentId: string): Promise<AgentAllowlistInput[]> {
  const rows = await db
    .select({
      entryType: schema.agentAllowlists.entryType,
      entryValue: schema.agentAllowlists.entryValue,
    })
    .from(schema.agentAllowlists)
    .where(eq(schema.agentAllowlists.agentId, agentId));
  return rows.map((r) => ({
    entry_type: r.entryType as AgentAllowlistEntryType,
    entry_value: r.entryValue,
  }));
}

async function loadSpendPolicy(clientId: string): Promise<{
  max_xrp_per_tx_drops: string | null;
  daily_xrp_limit_drops: string | null;
}> {
  const rows = await db
    .select({
      maxXrpPerTxDrops: schema.spendPolicies.maxXrpPerTxDrops,
      dailyXrpLimitDrops: schema.spendPolicies.dailyXrpLimitDrops,
      isActive: schema.spendPolicies.isActive,
    })
    .from(schema.spendPolicies)
    .where(eq(schema.spendPolicies.clientId, clientId))
    .limit(1);
  const row = rows[0];
  // No row, or row exists but is_active=false → no caps. Caller sees null/null
  // and can interpret that as "no cap installed" exactly like a preset that
  // disabled both fields.
  if (!row || !row.isActive) {
    return { max_xrp_per_tx_drops: null, daily_xrp_limit_drops: null };
  }
  return {
    max_xrp_per_tx_drops: row.maxXrpPerTxDrops,
    daily_xrp_limit_drops: row.dailyXrpLimitDrops,
  };
}

function rowToView(
  row: AgentJoinedRow,
  allowlist: AgentAllowlistInput[],
  spendPolicy: {
    max_xrp_per_tx_drops: string | null;
    daily_xrp_limit_drops: string | null;
  },
): AgentView {
  return {
    id: row.id,
    preset: row.preset,
    parent_address: row.parentAddress,
    agent_address: row.agentAddress,
    label: row.label,
    status: row.status,
    pending_revocation: row.pendingRevocation,
    allowlist,
    spend_policy: spendPolicy,
    created_at: row.createdAt,
    // agent_seed deliberately omitted — never returned on GET.
    // grant_tx_id deliberately omitted — only on POST response.
  };
}

export async function getAgent(clientId: string, agentId: string): Promise<AgentView | null> {
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
    .where(and(eq(schema.agents.clientId, clientId), eq(schema.agents.id, agentId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const [allowlist, spendPolicy] = await Promise.all([
    loadAllowlist(row.id),
    loadSpendPolicy(clientId),
  ]);
  return rowToView(row, allowlist, spendPolicy);
}

export async function listAgents(clientId: string): Promise<AgentView[]> {
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
    .limit(200);
  // Spend policy is currently shared across all agents of a client, so one
  // load instead of per-row. Allowlist is per-agent — sequential, since
  // tenants typically have a handful of agents (parallelizing would just
  // hammer Postgres for marginal gains and complicate error handling).
  const spendPolicy = await loadSpendPolicy(clientId);
  const views: AgentView[] = [];
  for (const row of rows) {
    const allowlist = await loadAllowlist(row.id);
    views.push(rowToView(row, allowlist, spendPolicy));
  }
  return views;
}

// ── Revocation (DELETE /v1/agents/:id) ──────────────────────────────────────
//
// Mirrors revokePermission's staging pattern (REVIEW.md C-1):
//   - This fn sets agents.pendingRevocation=true (NOT status='revoked')
//   - Calls permission.service.revokePermission to stage the underlying
//     delegations row + queue the SignerListSet that strips the delegate
//   - Rejects if pendingRevocation is already true (one revoke in flight)
//   - txConfirmer.applyDelegationRevocationOutcome commits the agent row's
//     status='revoked' on tesSUCCESS or clears pendingRevocation on
//     failure/expiry, mirroring the delegation row's transition
//
// Cross-tenant scope: the agent + clientId predicate refuses agents owned
// by other tenants. Indistinguishable from "not found" by design.

export interface RevokeAgentInput {
  clientId: string;
  agentId: string;
  idempotencyKey?: string;
}

export interface RevokeAgentResult {
  agent_id: string;
  status: 'revoking';
  /** ID of the SignerListSet tx that strips the delegate. */
  tx_id: string;
}

export async function revokeAgent(input: RevokeAgentInput): Promise<RevokeAgentResult> {
  const log = logger.child({
    service: 'agent',
    op: 'revoke',
    clientId: input.clientId,
    agentId: input.agentId,
  });

  // Load the agent + parent address. Cross-tenant safety: the WHERE clause
  // pairs id with clientId, so an agent owned by another tenant returns
  // null and surfaces as 'agent_not_found' (404). Same shape as getAgent.
  const rows = await db
    .select({
      id: schema.agents.id,
      status: schema.agents.status,
      pendingRevocation: schema.agents.pendingRevocation,
      agentAddress: schema.agents.agentAddress,
      parentAddress: schema.accounts.address,
    })
    .from(schema.agents)
    .innerJoin(schema.accounts, eq(schema.agents.parentAccountId, schema.accounts.id))
    .where(and(eq(schema.agents.id, input.agentId), eq(schema.agents.clientId, input.clientId)))
    .limit(1);
  const agent = rows[0];
  if (!agent) {
    throw new AgentServiceError('agent_not_found', 'Agent not found');
  }
  if (agent.status !== 'active') {
    // 'pending' would mean the grant SignerListSet hasn't validated yet —
    // refusing here keeps the revocation flow simple. Callers can wait
    // for the activation, then revoke. 'revoked' / 'failed' are terminal.
    throw new AgentServiceError(
      'agent_not_revocable',
      `Agent must be in status='active' to revoke (current: ${agent.status})`,
    );
  }
  if (agent.pendingRevocation) {
    throw new AgentServiceError(
      'agent_already_revoking',
      'Agent has a pending revocation — wait for on-chain confirmation',
    );
  }

  // Delegate to permission.service. revokePermission opens its own
  // transaction with FOR UPDATE on the delegation, queues the
  // SignerListSet, and stages delegations.pendingRevocation=true. We then
  // mirror the staging on the agents row in a second UPDATE.
  let revokeTxId: string;
  try {
    const result = await revokePermission({
      clientId: input.clientId,
      delegatorAddress: agent.parentAddress,
      delegateAddress: agent.agentAddress,
      idempotencyKey: input.idempotencyKey,
    });
    revokeTxId = result.tx_id;
  } catch (err) {
    if (err instanceof PermissionServiceError) {
      log.error(
        { err: err.message, code: err.code },
        'permission.revokePermission failed during agent revoke',
      );
      // Map onto our error codes. 'not_found' from permission.service
      // means the delegation has already been revoked — surface as
      // not-revocable rather than 404 to avoid client confusion.
      if (err.code === 'not_found') {
        throw new AgentServiceError(
          'agent_not_revocable',
          'No active delegation found — agent may already be revoked',
        );
      }
      if (err.code === 'invalid_input') {
        throw new AgentServiceError('agent_already_revoking', err.message);
      }
      throw new AgentServiceError(
        err.code === 'enqueue_failed' ? 'enqueue_failed' : 'db_conflict',
        `Failed to enqueue revocation: ${err.message}`,
      );
    }
    throw err;
  }

  // Mirror staging on the agents row. Guarded by the same status='active'
  // + pendingRevocation=false predicate so a concurrent caller can't
  // double-stage between our load and this update.
  await db
    .update(schema.agents)
    .set({ pendingRevocation: true })
    .where(
      and(
        eq(schema.agents.id, agent.id),
        eq(schema.agents.status, 'active'),
        eq(schema.agents.pendingRevocation, false),
      ),
    );

  log.info({ revokeTxId, agentAddress: agent.agentAddress }, 'agent revocation staged');

  return {
    agent_id: agent.id,
    status: 'revoking',
    tx_id: revokeTxId,
  };
}
