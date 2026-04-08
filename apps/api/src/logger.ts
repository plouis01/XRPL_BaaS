import pino from 'pino';

// Pino redact paths — extend this list when new sensitive fields are introduced.
// Per CLAUDE.md: never log signed blobs, seeds, or HSM responses.
const REDACT_PATHS = [
  '*.seed',
  '*.master_key',
  '*.master_key_ref',
  '*.private_key',
  '*.tx_blob',
  '*.signing_key',
  '*.hsm_response',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});
