// Public types exposed by @railforge/sdk consumers.
// Mirrors the API response shapes from apps/api/src/routes/*.

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export type Network = 'mainnet' | 'testnet';

export type TxStatus = 'queued' | 'submitted' | 'validated' | 'failed';

export type CustodyMode = 'semi' | 'non_custodial';

export type TokenType = 'mpt' | 'trustline';

export type WebhookEventType =
  | 'transaction.validated'
  | 'transaction.failed'
  | 'credential.issued'
  | 'credential.accepted'
  | 'credential.revoked'
  | 'credential.expiring'
  | 'domain.created'
  | 'domain.updated'
  | 'domain.deleted'
  | 'agent.activated'
  | 'agent.failed'
  | 'agent.revoked';

/** Returned by every async operation (202 Accepted). */
export interface QueuedTx {
  tx_id: string;
  status: 'queued';
}

/** Standard error body. */
export interface ApiError {
  error: string;
}

/** Options for state-changing requests. */
export interface RequestOptions {
  /** Caller-provided idempotency key for safe retries. Auto-generated if omitted. */
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface CreateAccountParams {
  label?: string;
  custody_mode?: CustodyMode;
  fund_amount?: string;
  multisign?: {
    quorum: number;
    signers: Array<{ address: string; weight: number }>;
  };
}

export interface Account {
  id: string;
  address: string;
  regular_key: string | null;
  custody_mode: CustodyMode;
  label: string | null;
  is_funded: boolean;
  reserve_balance: string;
  funding_tx_id: string | null;
  created_at: string;
}

export interface ConfigureSignersParams {
  quorum: number;
  signers: Array<{ address: string; weight: number }>;
}

export interface RotateKeyParams {
  regular_key?: string | null;
}

export interface DeleteAccountParams {
  destination: string;
  destination_tag?: number;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface CreateTokenParams {
  issuer: string;
  type?: TokenType;
  currency_code: string;
  transfer_fee?: number;
  clawback?: boolean;
  freeze_enabled?: boolean;
  max_supply?: string;
  metadata?: Record<string, unknown>;
  trustline_limit?: string;
}

export interface Token {
  id: string;
  issuer_address: string;
  token_type: TokenType;
  currency_code: string;
  mpt_issuance_id: string | null;
  transfer_fee: number;
  clawback: boolean;
  freeze_enabled: boolean;
  max_supply: string | null;
  status: TxStatus;
  tx_id: string;
  created_at: string | null;
}

export interface TransferTokenParams {
  destination: string;
  amount: string;
  destination_tag?: number;
}

export interface FreezeTokenParams {
  holder?: string;
  unfreeze?: boolean;
}

export interface ClawbackTokenParams {
  holder: string;
  amount: string;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type SendPaymentParams =
  | {
      source: string;
      destination: string;
      destination_tag?: number;
      memo?: string;
      amount_drops: string;
    }
  | {
      source: string;
      destination: string;
      destination_tag?: number;
      memo?: string;
      mpt_issuance_id: string;
      value: string;
    }
  | {
      source: string;
      destination: string;
      destination_tag?: number;
      memo?: string;
      currency: string;
      issuer: string;
      value: string;
    };

export interface Payment {
  id: string;
  tx_type: string;
  source_address: string;
  status: TxStatus;
  result_code: string | null;
  tx_hash: string | null;
  ledger_index: number | null;
  fee_drops: string | null;
  created_at: string | null;
  submitted_at: string | null;
  confirmed_at: string | null;
}

export interface CreateEscrowParams {
  source: string;
  destination: string;
  amount_drops: string;
  finish_after?: number;
  cancel_after?: number;
  condition?: string;
  destination_tag?: number;
}

export interface FinishEscrowParams {
  source: string;
  owner: string;
  offer_sequence: number;
}

export interface CancelEscrowParams {
  source: string;
  owner: string;
  offer_sequence: number;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface CreateWebhookEndpointParams {
  url: string;
  events: WebhookEventType[];
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: string | null;
}

export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
}

export interface WebhookEndpointList {
  data: WebhookEndpoint[];
}

// ---------------------------------------------------------------------------
// Credentials (XLS-70)
// ---------------------------------------------------------------------------

export interface IssueCredentialParams {
  issuer_address: string;
  subject_address: string;
  credential_type: string;
  expiration?: number;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface AcceptCredentialParams {
  subject_address: string;
}

export interface VerifyCredentialParams {
  subject_address: string;
  issuer_address: string;
  credential_type: string;
}

export interface Credential {
  id: string;
  issuer_address: string;
  subject_address: string;
  credential_type: string;
  status: string;
  expires_at: string | null;
  accepted_at: string | null;
  ledger_index: string | null;
  metadata: unknown;
  created_at: string | null;
}

export interface CredentialWithTx extends Credential {
  tx_id: string;
}

export interface VerifyCredentialResult {
  valid: boolean;
  credential: Credential | null;
}

export interface CredentialIssuer {
  id: string;
  name: string;
  address: string;
  provider: string;
  types: string[];
}

// ---------------------------------------------------------------------------
// Domains (XLS-80)
// ---------------------------------------------------------------------------

export interface AcceptedCredentialEntry {
  issuer: string;
  credential_type: string;
}

export interface CreateDomainParams {
  owner_address: string;
  accepted_credentials: AcceptedCredentialEntry[];
}

export interface UpdateDomainParams {
  accepted_credentials: AcceptedCredentialEntry[];
}

export interface CheckDomainMembershipParams {
  subject_address: string;
}

export interface Domain {
  id: string;
  owner_address: string;
  domain_id: string;
  accepted_credentials: AcceptedCredentialEntry[];
  created_at: string | null;
  updated_at: string | null;
}

export interface DomainWithTx extends Domain {
  tx_id: string;
}

export interface DomainMembershipResult {
  is_member: boolean;
  matching_credentials: string[];
}

export interface DomainMembersList {
  members: Array<{ subject_address: string; credential_ids: string[] }>;
}

// ---------------------------------------------------------------------------
// DEX
// ---------------------------------------------------------------------------

export interface AssetAmount {
  drops?: string;
  currency?: string;
  issuer?: string;
  value?: string;
  mpt_issuance_id?: string;
}

export interface AssetCurrency {
  drops?: true;
  currency?: string;
  issuer?: string;
  mpt_issuance_id?: string;
}

export interface CreateOfferParams {
  account: string;
  taker_gets: AssetAmount;
  taker_pays: AssetAmount;
  expiration?: number;
  offer_sequence?: number;
  flags?: number;
  domain_id?: string;
}

export interface CancelOfferParams {
  account: string;
  offer_sequence: number;
}

export interface AmmDepositParams {
  account: string;
  asset: AssetCurrency;
  asset2: AssetCurrency;
  amount?: AssetAmount;
  amount2?: AssetAmount;
  e_price?: AssetAmount;
  lp_token_out?: { currency: string; issuer: string; value: string };
  flags?: number;
}

export interface AmmWithdrawParams {
  account: string;
  asset: AssetCurrency;
  asset2: AssetCurrency;
  amount?: AssetAmount;
  amount2?: AssetAmount;
  e_price?: AssetAmount;
  lp_token_in?: { currency: string; issuer: string; value: string };
  flags?: number;
}

// ---------------------------------------------------------------------------
// Permissions (XLS-75 fallback: multi-sign roles)
// ---------------------------------------------------------------------------

export type PermissionValue =
  | 'Payment'
  | 'TrustSet'
  | 'OfferCreate'
  | 'OfferCancel'
  | 'AccountSet'
  | 'EscrowCreate'
  | 'EscrowFinish'
  | 'EscrowCancel'
  | 'CredentialCreate'
  | 'CredentialAccept'
  | 'CredentialDelete';

export interface GrantPermissionParams {
  delegator_address: string;
  delegate_address: string;
  permissions: PermissionValue[];
  weight?: number;
}

export interface RevokePermissionParams {
  delegator_address: string;
}

export interface Delegation {
  id: string;
  delegator_address: string;
  delegate_address: string;
  permissions: string[];
  status: string;
  created_at: string | null;
  revoked_at: string | null;
}

export interface DelegationWithTx extends Delegation {
  tx_id: string;
}

export interface AuditEntry {
  id: string;
  method: string;
  path: string;
  status_code: number;
  ip: string | null;
  created_at: string | null;
}

// ---------------------------------------------------------------------------
// Agents (VISION.md — agent launcher)
// ---------------------------------------------------------------------------

export type AgentPresetName = 'payment-agent' | 'treasury-agent';

export type AgentAllowlistEntryType = 'destination' | 'token' | 'domain';

export interface AgentAllowlistEntry {
  entry_type: AgentAllowlistEntryType;
  entry_value: string;
}

export interface AgentSpendPolicyOverride {
  max_xrp_per_tx_drops?: string | null;
  daily_xrp_limit_drops?: string | null;
}

export interface ProvisionAgentParams {
  preset: AgentPresetName;
  parent_address: string;
  label?: string;
  spend_policy?: AgentSpendPolicyOverride;
  allowlist?: AgentAllowlistEntry[];
  quorum?: number;
}

export interface AgentSpendPolicy {
  max_xrp_per_tx_drops: string | null;
  daily_xrp_limit_drops: string | null;
}

export interface Agent {
  id: string;
  preset: string;
  parent_address: string;
  agent_address: string;
  label: string | null;
  status: string;
  pending_revocation?: boolean;
  allowlist: AgentAllowlistEntry[];
  spend_policy: AgentSpendPolicy;
  created_at: string | null;
}

export interface ProvisionedAgent extends Agent {
  /** Delegate seed — returned exactly once. Persist before the response is discarded. */
  agent_seed: string;
  /** ID of the SignerListSet tx that grants on-ledger authority. */
  grant_tx_id: string;
}

export interface RevokeAgentResult {
  agent_id: string;
  status: 'revoking';
  /** ID of the SignerListSet tx that strips the delegate. */
  tx_id: string;
}
