export type Network = 'mainnet' | 'testnet';

export interface ApiKey {
  id: string;
  prefix: string;
  environment: Network;
  is_active: boolean;
  created_at: string;
  revoked_at: string | null;
  /** When set, this key is bound to an agent (sub-account delegate). */
  agent_id: string | null;
}

export interface AgentAllowlistEntry {
  entry_type: 'destination' | 'token' | 'domain';
  entry_value: string;
}

/**
 * Agent (semi-custodial sub-account delegate). The provisioning POST
 * returns an `agent_seed` field exactly once — read endpoints (list/get)
 * never include it.
 */
export interface Agent {
  id: string;
  preset: 'payment-agent' | 'treasury-agent' | string;
  parent_address: string;
  agent_address: string;
  label: string | null;
  status: 'pending' | 'active' | 'failed' | 'revoked' | string;
  /** True between DELETE /v1/agents/:id and the txConfirmer flip. */
  pending_revocation?: boolean;
  allowlist?: AgentAllowlistEntry[];
  spend_policy?: {
    max_per_tx_usd_cents: string | null;
    daily_limit_usd_cents: string | null;
  };
  created_at: string | null;
}

/** Lightweight row shape returned by GET /v1/dashboard/agents. */
export interface AgentSummary {
  id: string;
  preset: string;
  parent_address: string;
  agent_address: string;
  label: string | null;
  status: string;
  pending_revocation?: boolean;
  created_at: string | null;
}

export interface Transaction {
  id: string;
  tx_type: string;
  source_address: string;
  status: 'queued' | 'submitting' | 'submitted' | 'validated' | 'failed';
  tx_hash: string | null;
  result_code: string | null;
  ledger_index: number | null;
  created_at: string;
  confirmed_at: string | null;
}

/**
 * GET /v1/dashboard/agents/:id/transactions row shape. Adds `amount_drops`
 * (XRP-denominated only — null for token/cross-currency txs) on top of the
 * standard transaction view so the per-agent panel can show payment size.
 */
export interface AgentTransaction extends Transaction {
  amount_drops: string | null;
}

/**
 * GET /v1/dashboard/agents/:id/usage (migration 0019: USD-denominated).
 *
 * `scope` flags how the policy resolved:
 *   - 'agent'     → a per-agent override row applied
 *   - 'client'    → fell back to the tenant-wide default
 *   - 'unlimited' → no row of either kind, no caps
 *
 * Cent values are strings to avoid JS-number precision loss on large
 * caps. `xrp_usd_rate` is the conversion the API used at request time
 * for any XRP-denominated tx — surfaced so the UI can show the user
 * what rate is being applied and how stale the price feed is.
 */
export interface AgentUsage {
  daily_used_usd_cents: string;
  daily_limit_usd_cents: string | null;
  max_per_tx_usd_cents: string | null;
  scope: 'client' | 'agent' | 'unlimited';
  xrp_usd_rate: {
    cents: number;
    source: 'coingecko' | 'fallback';
    /** ISO-8601 timestamp of when the rate was last fetched. */
    fetched_at: string;
  };
}

export interface Credential {
  id: string;
  issuer_address: string;
  subject_address: string;
  credential_type: string;
  status: string;
  expires_at: string | null;
  accepted_at: string | null;
  created_at: string | null;
  ledger_index: string | null;
}

export interface Account {
  id: string;
  address: string;
  label: string | null;
  custody_mode: string;
  is_funded: boolean;
  created_at: string | null;
}

export interface Token {
  id: string;
  issuer_address: string;
  token_type: 'mpt' | 'trustline';
  currency_code: string;
  mpt_issuance_id: string | null;
  transfer_fee: number;
  clawback: boolean;
  freeze_enabled: boolean;
  max_supply: string | null;
  created_at: string | null;
}

export interface AccountBalances {
  address: string;
  xrp_drops: string;
  trustlines: Array<{ currency: string; issuer: string; balance: string }>;
  mpts: Array<{ mpt_issuance_id: string; balance: string }>;
}

export interface Domain {
  id: string;
  owner_address: string;
  domain_id: string;
  accepted_credentials: Array<{ issuer: string; credential_type: string }>;
  created_at: string | null;
  updated_at: string | null;
}

// x402 gated routes (SPRINT_10_PLAN §4.5).
export interface X402Route {
  id: string;
  path_pattern: string;
  payee_address: string;
  asset_kind: 'xrp' | 'mpt' | 'iou';
  asset_key: string | null;
  price_amount: string;
  is_active: boolean;
  created_at: string;
}
