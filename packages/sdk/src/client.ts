// RailForge SDK — main entry point.
// Constructs resource clients for all API resources.

import { HttpClient } from './http.ts';
import { Accounts } from './resources/accounts.ts';
import { Credentials } from './resources/credentials.ts';
import { Dex } from './resources/dex.ts';
import { Domains } from './resources/domains.ts';
import { Payments } from './resources/payments.ts';
import { Permissions } from './resources/permissions.ts';
import { Tokens } from './resources/tokens.ts';
import { Webhooks } from './resources/webhooks.ts';
import type { Network } from './types.ts';

const DEFAULT_URLS: Record<Network, string> = {
  testnet: 'https://api.testnet.railforge.dev',
  mainnet: 'https://api.railforge.dev',
};

export interface RailForgeOptions {
  apiKey: string;
  network?: Network;
  baseUrl?: string;
}

export class RailForge {
  readonly accounts: Accounts;
  readonly credentials: Credentials;
  readonly dex: Dex;
  readonly domains: Domains;
  readonly tokens: Tokens;
  readonly payments: Payments;
  readonly permissions: Permissions;
  readonly webhooks: Webhooks;

  constructor(opts: RailForgeOptions) {
    const baseUrl = opts.baseUrl ?? DEFAULT_URLS[opts.network ?? 'testnet'];
    const http = new HttpClient({ baseUrl, apiKey: opts.apiKey });

    this.accounts = new Accounts(http);
    this.credentials = new Credentials(http);
    this.dex = new Dex(http);
    this.domains = new Domains(http);
    this.tokens = new Tokens(http);
    this.payments = new Payments(http);
    this.permissions = new Permissions(http);
    this.webhooks = new Webhooks(http);
  }
}
