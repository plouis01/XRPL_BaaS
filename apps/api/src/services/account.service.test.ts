// Unit tests for account.service.ts.
//
// Strategy:
//   - Mock @railforge/db with a chainable query builder + controllable insert/select.
//   - Stub global fetch to simulate faucet responses.
//   - Never generate seeds in the test — xrpl.js Wallet is real, we just
//     verify the service doesn't leak them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbInsertCalls: Array<{ values: unknown }> = [];
const dbSelectResult = { current: [] as unknown[] };
const dbInsertResult = { current: [{ id: "acct-uuid-1" }] as unknown[] };
const dbInsertShouldThrow = { err: null as unknown };

vi.mock("@railforge/db", () => {
  const insert = vi.fn(() => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ values: v });
        if (dbInsertShouldThrow.err) {
          const err = dbInsertShouldThrow.err;
          dbInsertShouldThrow.err = null;
          throw err;
        }
        return dbInsertResult.current;
      }),
    })),
  }));
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => dbSelectResult.current),
      })),
    })),
  }));
  return {
    db: { insert, select },
    schema: {
      accounts: {
        id: "id",
        clientId: "clientId",
        address: "address",
        regularKey: "regularKey",
        custodyMode: "custodyMode",
        label: "label",
        isFunded: "isFunded",
        reserveBalance: "reserveBalance",
        createdAt: "createdAt",
        deletedAt: "deletedAt",
      },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
  };
});

// ── fetch mock ──────────────────────────────────────────────────────────────

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Import AFTER mocks.
const { createAccount, getAccount, AccountServiceError } =
  await import("./account.service.ts");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFaucetResponse(address: string, balance = 1000): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ account: { address }, balance }),
    text: async () => "",
  } as unknown as Response;
}

function makeFaucetError(status: number, text = "faucet bad"): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  } as unknown as Response;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createAccount", () => {
  beforeEach(() => {
    dbInsertCalls.length = 0;
    dbInsertResult.current = [{ id: "acct-uuid-1" }];
    dbInsertShouldThrow.err = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: generates wallet, funds via faucet, persists, returns redacted view", async () => {
    // We can't know the address ahead of time (it's random). Instead, we
    // respond to ANY address the service passes in by echoing it back.
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return makeFaucetResponse(body.destination);
    });

    const result = await createAccount({
      clientId: "client-1",
      label: "test-wallet",
    });

    // Response shape checks.
    expect(result.id).toBe("acct-uuid-1");
    expect(result.address).toMatch(/^r/); // XRPL r-address
    expect(result.isFunded).toBe(true);
    expect(result.label).toBe("test-wallet");
    expect(result.custodyMode).toBe("semi");
    expect(result.regularKey).toBeNull();

    // CRITICAL: no seed in the response.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/seed/i);
    expect(serialized).not.toMatch(/master_key_ref/i);
    expect(serialized).not.toMatch(/^s[a-zA-Z1-9]{28}/); // XRPL seed format

    // DB insert was called with masterKeyRef containing the seed.
    expect(dbInsertCalls).toHaveLength(1);
    const values = dbInsertCalls[0]!.values as Record<string, unknown>;
    expect(values.clientId).toBe("client-1");
    expect(values.address).toBe(result.address);
    expect(values.isFunded).toBe(true);
    expect(values.custodyMode).toBe("semi");
    // masterKeyRef should look like an xrpl seed (starts with 's', ~29 chars).
    expect(values.masterKeyRef).toMatch(/^s[a-zA-Z1-9]{28}/);
  });

  it('defaults custody_mode to "semi" when not provided', async () => {
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return makeFaucetResponse(body.destination);
    });

    const result = await createAccount({ clientId: "client-1" });
    expect(result.custodyMode).toBe("semi");
  });

  it('throws AccountServiceError with code "faucet_failed" on 503 from faucet', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFaucetError(503, "service unavailable"),
    );

    const err = await createAccount({ clientId: "client-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as InstanceType<typeof AccountServiceError>).code).toBe(
      "faucet_failed",
    );

    // No DB insert if the faucet failed.
    expect(dbInsertCalls).toHaveLength(0);
  });

  it('throws AccountServiceError with code "faucet_failed" when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const err = await createAccount({ clientId: "client-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as InstanceType<typeof AccountServiceError>).code).toBe(
      "faucet_failed",
    );
    expect(dbInsertCalls).toHaveLength(0);
  });

  it('throws AccountServiceError with code "faucet_bad_response" when faucet returns a different address', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFaucetResponse("rSomethingElse000000000000000000"),
    );

    const err = await createAccount({ clientId: "client-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as InstanceType<typeof AccountServiceError>).code).toBe(
      "faucet_bad_response",
    );
  });

  it('throws AccountServiceError with code "db_conflict" on unique-violation (Postgres 23505)', async () => {
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return makeFaucetResponse(body.destination);
    });
    dbInsertShouldThrow.err = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });

    const err = await createAccount({ clientId: "client-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as InstanceType<typeof AccountServiceError>).code).toBe(
      "db_conflict",
    );
  });

  it("rethrows non-unique DB errors unchanged (global error handler deals with them)", async () => {
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return makeFaucetResponse(body.destination);
    });
    dbInsertShouldThrow.err = new Error("connection lost");

    const err = await createAccount({ clientId: "client-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AccountServiceError);
    expect((err as Error).message).toBe("connection lost");
  });
});

describe("getAccount", () => {
  beforeEach(() => {
    dbSelectResult.current = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no row matches (not-found OR wrong client)", async () => {
    dbSelectResult.current = [];
    const result = await getAccount("client-1", "rAddress");
    expect(result).toBeNull();
  });

  it("returns the account view when the row exists and belongs to the client", async () => {
    dbSelectResult.current = [
      {
        id: "acct-1",
        address: "rKnown000000000000000000000000000",
        regularKey: null,
        custodyMode: "semi",
        label: "my-wallet",
        isFunded: true,
        reserveBalance: "10000000",
        createdAt: new Date("2026-04-09T12:00:00Z"),
      },
    ];

    const result = await getAccount(
      "client-1",
      "rKnown000000000000000000000000000",
    );
    expect(result).not.toBeNull();
    expect(result?.id).toBe("acct-1");
    expect(result?.address).toBe("rKnown000000000000000000000000000");
    expect(result?.isFunded).toBe(true);
    expect(result?.reserveBalance).toBe("10000000");
  });

  it("never exposes master_key_ref in the view (redaction contract)", async () => {
    // The service SELECT column list doesn't include master_key_ref at all —
    // this test is belt-and-braces. If someone ever adds master_key_ref to
    // the select list, the view's JSON will contain seed material.
    dbSelectResult.current = [
      {
        id: "acct-1",
        address: "rX",
        regularKey: null,
        custodyMode: "semi",
        label: null,
        isFunded: true,
        reserveBalance: "0",
        createdAt: new Date(),
        // Even if the mock DB returned master_key_ref, the view's known
        // shape should not include it.
        masterKeyRef: "sLEAKED",
      },
    ];

    const result = await getAccount("client-1", "rX");
    const json = JSON.stringify(result);
    expect(json).not.toContain("LEAKED");
    expect(json).not.toMatch(/master_key/i);
  });

  it("coerces isFunded=null from the DB to false in the view", async () => {
    dbSelectResult.current = [
      {
        id: "acct-1",
        address: "rX",
        regularKey: null,
        custodyMode: "semi",
        label: null,
        isFunded: null,
        reserveBalance: null,
        createdAt: null,
      },
    ];

    const result = await getAccount("client-1", "rX");
    expect(result?.isFunded).toBe(false);
    expect(result?.reserveBalance).toBe("0");
  });
});
