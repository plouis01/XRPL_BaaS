// Unit tests for token.service.ts.
//
// Coverage (the 6 behaviors that matter for correctness + security):
//   1. Happy path MPT: issuer lookup → transactions insert → tokens insert → enqueue
//   2. Issuer belongs to another client → 404 (cross-tenant isolation)
//   3. Issuer not funded → error
//   4. Trustline type → explicit "not supported yet" error (no silent fallback)
//   5. Enqueue receives a well-formed TxSubmitJob payload
//   6. Tokens row is inserted with mpt_issuance_id = null (backfilled later)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbState = {
  issuerRow: null as unknown,
  txInsertResult: [{ id: "tx-uuid-1" }] as unknown[],
  tokenInsertResult: [{ id: "token-uuid-1" }] as unknown[],
  txInsertCalls: [] as Array<{ values: unknown }>,
  tokenInsertCalls: [] as Array<{ values: unknown }>,
};

vi.mock("@railforge/db", () => {
  // Select chain ends in limit() which returns the mocked issuer row.
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          // Return empty unless the test has set an issuer row.
          if (!dbState.issuerRow) return [];
          // Only respond for the accounts table.
          const tableName =
            table && typeof table === "object" && "id" in table
              ? (table as { id: string }).id
              : "";
          return tableName ? [dbState.issuerRow] : [];
        }),
      })),
    })),
  }));

  // Insert chain ends in returning() — we identify which table via the
  // `schema.xxx` object reference passed to insert().
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        // We tag each mocked schema table with a unique `id` field; the
        // tests compare by reference identity.
        if (table === schemaStub.transactions) {
          dbState.txInsertCalls.push({ values: v });
          return dbState.txInsertResult;
        }
        if (table === schemaStub.tokens) {
          dbState.tokenInsertCalls.push({ values: v });
          return dbState.tokenInsertResult;
        }
        return [];
      }),
    })),
  }));

  const schemaStub = {
    accounts: {
      id: "accounts",
      clientId: "clientId",
      address: "address",
      isFunded: "isFunded",
      deletedAt: "deletedAt",
    },
    transactions: {
      id: "transactions-id", // different value so comparisons work
      clientId: "clientId",
    },
    tokens: {
      id: "tokens-id",
      clientId: "clientId",
    },
  };

  return {
    db: { select, insert },
    schema: schemaStub,
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
  };
});

// ── @railforge/jobs mock ────────────────────────────────────────────────────

const enqueueCalls: Array<{ data: unknown }> = [];
vi.mock("@railforge/jobs", () => ({
  enqueueTxSubmit: vi.fn(async (data: unknown) => {
    enqueueCalls.push({ data });
  }),
}));

// Import after mocks.
const { createToken, TokenServiceError } = await import("./token.service.ts");

// ── Test helpers ────────────────────────────────────────────────────────────

const FUNDED_ISSUER = {
  id: "acct-uuid-1",
  address: "rIssuer0000000000000000000000000",
  isFunded: true,
};

function baseInput(overrides: Partial<Parameters<typeof createToken>[0]> = {}) {
  return {
    clientId: "client-1",
    issuer: "rIssuer0000000000000000000000000",
    type: "mpt" as const,
    currencyCode: "USD",
    transferFee: 0,
    clawback: true,
    freezeEnabled: true,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createToken", () => {
  beforeEach(() => {
    dbState.issuerRow = FUNDED_ISSUER;
    dbState.txInsertResult = [{ id: "tx-uuid-1" }];
    dbState.tokenInsertResult = [{ id: "token-uuid-1" }];
    dbState.txInsertCalls.length = 0;
    dbState.tokenInsertCalls.length = 0;
    enqueueCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: inserts tx row, inserts token row, enqueues TxSubmit", async () => {
    const result = await createToken(baseInput());

    // Response shape
    expect(result.id).toBe("token-uuid-1");
    expect(result.txId).toBe("tx-uuid-1");
    expect(result.status).toBe("queued");
    expect(result.mptIssuanceId).toBeNull();
    expect(result.issuerAddress).toBe(FUNDED_ISSUER.address);
    expect(result.issuerAccountId).toBe(FUNDED_ISSUER.id);
    expect(result.tokenType).toBe("mpt");
    expect(result.currencyCode).toBe("USD");

    // DB writes in the correct order.
    expect(dbState.txInsertCalls).toHaveLength(1);
    expect(dbState.tokenInsertCalls).toHaveLength(1);

    // Transactions row has the right source address + tx_type.
    const txValues = dbState.txInsertCalls[0]!.values as Record<
      string,
      unknown
    >;
    expect(txValues.clientId).toBe("client-1");
    expect(txValues.sourceAddress).toBe(FUNDED_ISSUER.address);
    expect(txValues.txType).toBe("MPTokenIssuanceCreate");
    expect(txValues.status).toBe("queued");
    expect(txValues.requestBody).toMatchObject({
      op: "createToken",
      issuer: FUNDED_ISSUER.address,
      type: "mpt",
    });

    // Tokens row references the issuer account and has mpt_issuance_id = null.
    const tokenValues = dbState.tokenInsertCalls[0]!.values as Record<
      string,
      unknown
    >;
    expect(tokenValues.clientId).toBe("client-1");
    expect(tokenValues.issuerAccount).toBe(FUNDED_ISSUER.id);
    expect(tokenValues.tokenType).toBe("mpt");
    expect(tokenValues.mptIssuanceId).toBeNull();

    // Enqueue received a TxSubmit payload with the right shape.
    expect(enqueueCalls).toHaveLength(1);
    const enq = enqueueCalls[0]!.data as {
      txId: string;
      sourceAddress: string;
      txJson: { TransactionType: string };
    };
    expect(enq.txId).toBe("tx-uuid-1");
    expect(enq.sourceAddress).toBe(FUNDED_ISSUER.address);
    expect(enq.txJson.TransactionType).toBe("MPTokenIssuanceCreate");
  });

  it("cross-tenant isolation: issuer belonging to another client → issuer_not_found", async () => {
    dbState.issuerRow = null; // SELECT scoped by clientId returns nothing

    const err = await createToken(baseInput()).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe(
      "issuer_not_found",
    );

    // Critically: no tx row, no token row, no enqueue.
    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(dbState.tokenInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("issuer not yet funded → issuer_not_found (with explanatory message)", async () => {
    dbState.issuerRow = { ...FUNDED_ISSUER, isFunded: false };

    const err = await createToken(baseInput()).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe(
      "issuer_not_found",
    );
    expect((err as Error).message).toMatch(/not yet funded/);

    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("trustline type → trustline_not_supported_yet (explicit, no silent fallback)", async () => {
    const err = await createToken(baseInput({ type: "trustline" })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe(
      "trustline_not_supported_yet",
    );

    // No side effects.
    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(dbState.tokenInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("passes transferFee and maxSupply through to the builder and DB", async () => {
    await createToken(baseInput({ transferFee: 250, maxSupply: "1000000000" }));

    const tokenValues = dbState.tokenInsertCalls[0]!.values as Record<
      string,
      unknown
    >;
    expect(tokenValues.transferFee).toBe(250);
    expect(tokenValues.maxSupply).toBe("1000000000");

    const enq = enqueueCalls[0]!.data as {
      txJson: { TransferFee?: number; MaximumAmount?: string };
    };
    expect(enq.txJson.TransferFee).toBe(250);
    expect(enq.txJson.MaximumAmount).toBe("1000000000");
  });
});
