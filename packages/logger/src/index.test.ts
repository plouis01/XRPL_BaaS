// Verifies that the shared Pino logger redacts sensitive fields.
// "never log signed blobs, seeds, or HSM responses" — these tests are
// the enforcement point. Writing the REDACT_PATHS list is not enough; we
// also have to prove pino actually drops the values.
//
// Strategy: build a fresh pino logger using the SAME REDACT_PATHS list the
// production logger uses, stream output into an in-memory buffer, then
// assert the captured JSON contains '[REDACTED]' (or no trace of) the secret.

import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from './index.ts';

function makeBufferedLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = {
    write: (chunk: string) => {
      lines.push(chunk);
    },
  };
  const logger = pino(
    {
      level: 'info',
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
    },
    stream as pino.DestinationStream,
  );
  return { logger, lines };
}

const SECRET = 'sEdNeverSeenInLogs00000000000';

describe('logger redact (snake_case)', () => {
  it('redacts seed under any object key', () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info({ tx: { seed: SECRET, address: 'r123' } }, 'tx event');
    const out = lines.join('');
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('r123');
  });

  it('redacts tx_blob', () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info({ tx: { tx_blob: 'DEADBEEF', hash: 'ABC' } }, 'tx submitted');
    const out = lines.join('');
    expect(out).not.toContain('DEADBEEF');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('ABC'); // hash is NOT secret, must remain
  });

  it('redacts master_key, master_key_ref, private_key, signing_key, hsm_response', () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info(
      {
        signer: {
          master_key: 'M1',
          master_key_ref: 'M2',
          private_key: 'M3',
          signing_key: 'M4',
          hsm_response: 'M5',
        },
      },
      'sign attempt',
    );
    const out = lines.join('');
    for (const m of ['M1', 'M2', 'M3', 'M4', 'M5']) {
      expect(out).not.toContain(m);
    }
  });
});

describe('logger redact (camelCase — xrpl.js Wallet exposes these)', () => {
  it('redacts privateKey, publicKey, txBlob, signingKey, hsmResponse, masterKey, masterKeyRef', () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info(
      {
        signer: {
          privateKey: 'C1',
          publicKey: 'C2',
          txBlob: 'C3',
          signingKey: 'C4',
          hsmResponse: 'C5',
          masterKey: 'C6',
          masterKeyRef: 'C7',
        },
      },
      'camelcase event',
    );
    const out = lines.join('');
    for (const m of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']) {
      expect(out).not.toContain(m);
    }
  });

  it('redacts a top-level wallet object wholesale (defense in depth)', () => {
    // This is the most important camelCase test: if a future caller writes
    // logger.info({ wallet }) where wallet is an xrpl.js Wallet instance, we
    // need to drop the WHOLE object — privateKey, seed, classicAddress, all
    // of it. The 'wallet' wildcard in REDACT_PATHS handles this.
    const { logger, lines } = makeBufferedLogger();
    logger.info(
      {
        wallet: {
          seed: 'sEdLEAKED1',
          privateKey: 'PRIVLEAKED2',
          publicKey: 'PUBLIC3',
          classicAddress: 'rABC',
        },
      },
      'wallet logged',
    );
    const out = lines.join('');
    expect(out).not.toContain('sEdLEAKED1');
    expect(out).not.toContain('PRIVLEAKED2');
    // The whole wallet field must be censored — even the address.
    expect(out).not.toContain('rABC');
  });

  it('redacts nested *.wallet under any parent', () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info(
      {
        ctx: { wallet: { seed: 'sEdNESTED1', privateKey: 'NESTEDPRIV' } },
      },
      'nested wallet',
    );
    const out = lines.join('');
    expect(out).not.toContain('sEdNESTED1');
    expect(out).not.toContain('NESTEDPRIV');
  });
});

describe('logger redact (HTTP headers)', () => {
  it('redacts req.headers.authorization and req.headers["x-api-key"]', () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer leaked-token',
            'x-api-key': 'rf_live_leaked_key',
            'user-agent': 'test/1.0',
          },
        },
      },
      'request',
    );
    const out = lines.join('');
    expect(out).not.toContain('leaked-token');
    expect(out).not.toContain('rf_live_leaked_key');
    expect(out).toContain('test/1.0'); // non-sensitive headers must pass through
  });
});

describe('logger redact (negative cases)', () => {
  it('does not redact non-sensitive top-level fields', () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info({ clientId: 'abc-123', port: 3000 }, 'startup');
    const out = lines.join('');
    expect(out).toContain('abc-123');
    expect(out).toContain('3000');
  });
});
