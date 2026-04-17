// Read-only XRPL client for the API process.
//
// Write-path operations (signing, submission, sequencing) happen in the
// worker and use the full XrplClientPool. The API doesn't need that —
// it only needs read-only rippled calls for:
//
//   - GET /v1/accounts/:address/balances   (account_info, account_lines, account_objects)
//   - GET /v1/dex/orderbook/:base/:counter (book_offers)
//   - GET /v1/dex/amm/:asset1/:asset2      (amm_info)
//
// A single lazily-connected Client is sufficient — the request volume is
// low and the calls are idempotent. We expose getReadClient() which
// connects on first call and reconnects on error. Tests inject a fake
// via __setReadClientForTests.

import { MAINNET_WS_URLS, TESTNET_WS_URL } from '@railforge/xrpl-core';
import { Client } from 'xrpl';
import { logger } from '../logger.ts';

const log = logger.child({ component: 'read-client' });

/**
 * Minimal subset of xrpl.js Client surface used by the read-only paths.
 * Defined as an interface so tests can inject a mock without instantiating
 * a real Client (which opens a WebSocket).
 */
export interface ReadClient {
  request: (req: {
    command: string;
    [k: string]: unknown;
  }) => Promise<{ result: unknown }>;
}

let cached: ReadClient | null = null;
let connecting: Promise<ReadClient> | null = null;

function pickUrl(): string {
  const network = process.env.XRPL_NETWORK ?? 'testnet';
  if (network === 'mainnet') {
    const first = MAINNET_WS_URLS[0];
    if (!first) throw new Error('MAINNET_WS_URLS is empty');
    return first;
  }
  return process.env.XRPL_WS_URL ?? TESTNET_WS_URL;
}

async function connect(): Promise<ReadClient> {
  const url = pickUrl();
  const client = new Client(url);
  await client.connect();
  log.info({ url }, 'read-client connected');
  return client as unknown as ReadClient;
}

/**
 * Return a connected read-only client. Lazily connects on first call.
 * Subsequent calls return the cached client.
 */
export async function getReadClient(): Promise<ReadClient> {
  if (cached) return cached;
  if (connecting) return connecting;
  connecting = connect()
    .then((c) => {
      cached = c;
      connecting = null;
      return c;
    })
    .catch((err) => {
      connecting = null;
      throw err;
    });
  return connecting;
}

/** Test seam: inject a fake ReadClient. Production code never calls this. */
export function __setReadClientForTests(fake: ReadClient | null): void {
  cached = fake;
  connecting = null;
}
