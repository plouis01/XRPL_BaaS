// Shared Pino logger for all RailForge apps. Single source of truth for the
// REDACT_PATHS list — extending it here automatically protects api, worker,
// and indexer.
//
// rule: never log signed blobs, seeds, or HSM responses.
//
// CRITICAL: the redact list must cover BOTH snake_case (our internal payload
// shapes) AND camelCase (xrpl.js Wallet exposes `seed`, `privateKey`,
// `publicKey`, `classicAddress` directly on instances). A future
// `logger.info({ wallet })` would otherwise leak the private key. The
// `'wallet'` and `'*.wallet'` wildcards are belt-and-braces — they redact
// the entire wallet object regardless of which fields it contains.

import pino from 'pino';

export const REDACT_PATHS = [
  // Top-level wallet object — redact wholesale.
  'wallet',
  '*.wallet',
  'wallets',
  '*.wallets',

  // snake_case (our internal types)
  '*.seed',
  '*.master_key',
  '*.master_key_ref',
  '*.private_key',
  '*.tx_blob',
  '*.signing_key',
  '*.hsm_response',

  // camelCase (xrpl.js Wallet + future code)
  '*.privateKey',
  '*.publicKey',
  '*.txBlob',
  '*.signingKey',
  '*.hsmResponse',
  '*.masterKey',
  '*.masterKeyRef',

  // HTTP headers
  'req.headers.authorization',
  'req.headers["x-api-key"]',
];

export interface LoggerOptions {
  /** Logger name (e.g. 'api', 'worker', 'indexer') — added as a top-level field. */
  name: string;
  /** Override the log level. Defaults to LOG_LEVEL env var, then 'info'. */
  level?: string;
}

export function createLogger(opts: LoggerOptions): pino.Logger {
  const isProd = process.env.NODE_ENV === 'production';
  return pino({
    name: opts.name,
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    ...(isProd
      ? {}
      : {
          transport: { target: 'pino-pretty', options: { colorize: true } },
        }),
  });
}

export type Logger = pino.Logger;
