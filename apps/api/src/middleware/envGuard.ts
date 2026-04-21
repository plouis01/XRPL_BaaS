// Mainnet/testnet route enforcement middleware.
//
// PLAN.md §9.2 #1 (HIGH): reject testnet API keys on mainnet routes and
// vice versa. The `environment` field on the API key ('testnet' | 'mainnet')
// must match the server's configured XRPL_NETWORK. A testnet key hitting a
// mainnet server (or the reverse) is always a misconfiguration — fail fast
// with a clear error rather than letting a transaction hit the wrong network.
//
// This runs AFTER auth (which sets c.get('environment')) and BEFORE any
// route handler.
//
// REVIEW.md HIGH-05: XRPL_NETWORK is mandatory. Previously we defaulted to
// 'testnet' when unset — that silently turned a mainnet deploy with a
// forgotten env var into "rejects mainnet keys, accepts testnet keys against
// the mainnet rippled pool." Now we refuse to boot without an explicit
// setting in {testnet, mainnet, devnet}.

import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger.ts';
import type { AppEnv } from '../types.ts';

const ALLOWED_NETWORKS = ['testnet', 'mainnet', 'devnet'] as const;
type ServerNetwork = (typeof ALLOWED_NETWORKS)[number];

export function resolveServerNetwork(): ServerNetwork {
  const raw = process.env.XRPL_NETWORK;
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      'XRPL_NETWORK is required. Set it to one of testnet | mainnet | devnet ' +
        'in your .env (see .env.example). Defaulting silently would mask a ' +
        'mainnet misconfiguration.',
    );
  }
  const normalized = raw.trim().toLowerCase();
  if (!ALLOWED_NETWORKS.includes(normalized as ServerNetwork)) {
    throw new Error(`XRPL_NETWORK=${raw} is not one of ${ALLOWED_NETWORKS.join(' | ')}.`);
  }
  return normalized as ServerNetwork;
}

const SERVER_NETWORK: ServerNetwork = resolveServerNetwork();

export const envGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const keyEnv = c.get('environment');

  if (keyEnv !== SERVER_NETWORK) {
    logger.warn(
      {
        apiKeyId: c.get('apiKeyId'),
        keyEnvironment: keyEnv,
        serverNetwork: SERVER_NETWORK,
      },
      'environment mismatch: API key does not match server network',
    );

    return c.json(
      {
        error: 'Environment mismatch',
        detail: `This API key is configured for ${keyEnv}, but the server is running on ${SERVER_NETWORK}`,
      },
      403,
    );
  }

  await next();
  return;
};
