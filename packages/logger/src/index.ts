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

/**
 * XRPL seed pattern. Matches the secret-seed format (`s` + 28 chars from the
 * base58 alphabet). Same pattern as Hook 5 (secret-scan on commit).
 *
 * REVIEW.md MED-07: Pino's `redact.paths` only scrubs field *names* — it does
 * nothing for seed fragments that end up inside `err.message` or `err.stack`.
 * xrpl.js has historically included seed fragments in error strings when a
 * Wallet is constructed with a malformed seed, and any error-path log call
 * that serializes the error with the default serializer would leak it. The
 * `err` serializer below runs this regex over `message` and `stack` before
 * the log event is emitted.
 */
const XRPL_SEED_PATTERN = /\bs[a-zA-HJ-NP-Z1-9]{28}\b/g;

function scrubSeeds(text: string): string {
  return text.replace(XRPL_SEED_PATTERN, '[SEED_REDACTED]');
}

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
  // REVIEW.md MED-17: after HIGH-03 the dashboard session cookie carries
  // the raw API key (`railforge_session=rf_test_...`), so the Cookie
  // header is just as credential-bearing as the two above. Both spellings
  // because pino's path matcher is case-sensitive and request-logger
  // middlewares differ on the casing they emit.
  'req.headers.cookie',
  'req.headers["cookie"]',
  'req.headers.Cookie',
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
    // REVIEW.md MED-07: override Pino's default err serializer so both
    // `err.message` and `err.stack` are scrubbed for XRPL seed fragments
    // before emission. The default serializer copies message/stack verbatim.
    serializers: {
      err: (err: Error) => {
        const name = typeof err?.name === 'string' ? err.name : (err?.constructor?.name ?? 'Error');
        const message = typeof err?.message === 'string' ? scrubSeeds(err.message) : '';
        const stack = typeof err?.stack === 'string' ? scrubSeeds(err.stack) : undefined;
        return { type: name, message, stack };
      },
    },
    ...(isProd
      ? {}
      : {
          transport: { target: 'pino-pretty', options: { colorize: true } },
        }),
  });
}

export type Logger = pino.Logger;
