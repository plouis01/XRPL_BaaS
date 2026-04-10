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

import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger.ts';
import type { AppEnv } from '../types.ts';

const SERVER_NETWORK = process.env.XRPL_NETWORK ?? 'testnet';

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
