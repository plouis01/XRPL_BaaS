// HTTP client wrapper. Constructs RailForge resource clients (accounts,
// tokens, payments, credentials, domains, dex).
// TODO Sprint 4.

export interface RailForgeOptions {
  apiKey: string;
  network: 'mainnet' | 'testnet';
  baseUrl?: string;
}

export class RailForge {
  constructor(private opts: RailForgeOptions) {}
}
