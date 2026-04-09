// Verifies that the Pino logger redacts sensitive fields. CLAUDE.md says
// "never log signed blobs, seeds, or HSM responses" — these tests are the
// enforcement point. Writing the redact list is not enough; we also have to
// prove pino actually drops the values.
//
// Strategy: capture log output to a buffer via a custom destination, log an
// object containing every sensitive field, then assert the captured JSON
// contains '[REDACTED]' instead of the secret value.

import pino from "pino";
import { describe, expect, it } from "vitest";

// Re-import the redact list from logger.ts. We can't easily import the live
// logger because it pipes to pino-pretty in dev — instead we construct a
// fresh pino with the same redact config and stream to a buffer.
const REDACT_PATHS = [
  "*.seed",
  "*.master_key",
  "*.master_key_ref",
  "*.private_key",
  "*.tx_blob",
  "*.signing_key",
  "*.hsm_response",
  "req.headers.authorization",
  'req.headers["x-api-key"]',
];

function makeBufferedLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = {
    write: (chunk: string) => {
      lines.push(chunk);
    },
  };
  const logger = pino(
    {
      level: "info",
      redact: {
        paths: REDACT_PATHS,
        censor: "[REDACTED]",
      },
    },
    stream as pino.DestinationStream,
  );
  return { logger, lines };
}

const SECRET = "sEdNeverSeenInLogs00000000000";

describe("logger redact", () => {
  it("redacts seed under any object key", () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info({ wallet: { seed: SECRET, address: "r123" } }, "wallet event");
    const out = lines.join("");
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("r123");
  });

  it("redacts tx_blob", () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info({ tx: { tx_blob: "DEADBEEF", hash: "ABC" } }, "tx submitted");
    const out = lines.join("");
    expect(out).not.toContain("DEADBEEF");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("ABC"); // hash is NOT secret, must remain
  });

  it("redacts master_key, master_key_ref, private_key, signing_key, hsm_response", () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info(
      {
        signer: {
          master_key: "M1",
          master_key_ref: "M2",
          private_key: "M3",
          signing_key: "M4",
          hsm_response: "M5",
        },
      },
      "sign attempt",
    );
    const out = lines.join("");
    for (const m of ["M1", "M2", "M3", "M4", "M5"]) {
      expect(out).not.toContain(m);
    }
  });

  it('redacts req.headers.authorization and req.headers["x-api-key"]', () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info(
      {
        req: {
          headers: {
            authorization: "Bearer leaked-token",
            "x-api-key": "rf_live_leaked_key",
            "user-agent": "test/1.0",
          },
        },
      },
      "request",
    );
    const out = lines.join("");
    expect(out).not.toContain("leaked-token");
    expect(out).not.toContain("rf_live_leaked_key");
    expect(out).toContain("test/1.0"); // non-sensitive headers must pass through
  });

  it("does not redact non-sensitive top-level fields", () => {
    const { logger, lines } = makeBufferedLogger();
    logger.info({ clientId: "abc-123", port: 3000 }, "startup");
    const out = lines.join("");
    expect(out).toContain("abc-123");
    expect(out).toContain("3000");
  });
});
