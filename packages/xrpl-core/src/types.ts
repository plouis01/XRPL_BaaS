// Shared XRPL-related type definitions used across api/worker/indexer.

export type XrplNetwork = 'mainnet' | 'testnet';

export type CustodyMode = 'semi' | 'non_custodial';

export type TokenType = 'mpt' | 'trustline';

export interface SignerEntry {
  address: string;
  weight: number;
}
