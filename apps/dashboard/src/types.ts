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
