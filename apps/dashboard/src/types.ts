export type Network = 'mainnet' | 'testnet';

export interface ApiKey {
  id: string;
  prefix: string;
  environment: Network;
  is_active: boolean;
  created_at: string;
  revoked_at: string | null;
}

export interface Transaction {
  id: string;
  tx_type: string;
  source_address: string;
  status: 'queued' | 'submitted' | 'validated' | 'failed';
  tx_hash: string | null;
  result_code: string | null;
  ledger_index: number | null;
  created_at: string;
  confirmed_at: string | null;
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
}

export interface Domain {
  id: string;
  owner_address: string;
  domain_id: string;
  accepted_credentials: Array<{ issuer: string; credential_type: string }>;
  created_at: string | null;
  updated_at: string | null;
}
