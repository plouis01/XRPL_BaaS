// Unit tests for token.service.ts.
//
// Coverage (the 6 behaviors that matter for correctness + security):
//   1. Happy path MPT: issuer lookup → transactions insert → tokens insert → enqueue
//   2. Issuer belongs to another client → 404 (cross-tenant isolation)
//   3. Issuer not funded → error
//   4. Trustline type → explicit "not supported yet" error (no silent fallback)
//   5. Enqueue receives a well-formed TxSubmitJob payload
//   6. Tokens row is inserted with mpt_issuance_id = null (backfilled later)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbState = {
  issuerRow: null as unknown,
  txInsertResult: [{ id: 'tx-uuid-1' }] as unknown[],
  tokenInsertResult: [{ id: 'token-uuid-1' }] as unknown[],
  txInsertCalls: [] as Array<{ values: unknown }>,
  tokenInsertCalls: [] as Array<{ values: unknown }>,
};

// Sprint 3 ops (transfer/freeze/clawback): the resolveToken helper uses a
// select().from().innerJoin().where().limit() chain. Tests set this state
// to control what the JOIN returns.
const dbState2 = {
  resolvedToken: null as unknown,
};

vi.mock('@railforge/db', () => {
  // Select chain. Two shapes are exposed:
  //   - select().from().where().limit()         → original createToken path
  //   - select().from().innerJoin().where().limit() → resolveToken (token ops)
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          if (!dbState.issuerRow) return [];
          const tableName =
            table && typeof table === 'object' && 'id' in table ? (table as { id: string }).id : '';
          return tableName ? [dbState.issuerRow] : [];
        }),
      })),
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (dbState2.resolvedToken ? [dbState2.resolvedToken] : [])),
        })),
      })),
    })),
  }));

  // Insert chain ends in returning() — we identify which table via the
  // `schema.xxx` object reference passed to insert().
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
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
      id: 'accounts',
      clientId: 'clientId',
      address: 'address',
      isFunded: 'isFunded',
      deletedAt: 'deletedAt',
    },
    transactions: {
      id: 'transactions-id', // different value so comparisons work
      clientId: 'clientId',
    },
    tokens: {
      id: 'tokens-id',
      clientId: 'clientId',
      tokenType: 'tokenType',
      currencyCode: 'currencyCode',
      mptIssuanceId: 'mptIssuanceId',
      issuerAccount: 'issuerAccount',
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
vi.mock('@railforge/jobs', () => ({
  enqueueTxSubmit: vi.fn(async (data: unknown) => {
    enqueueCalls.push({ data });
  }),
}));

// ── spendPolicy.service mock ────────────────────────────────────────────────
// Token-op enforcement now resolves the policy via spendPolicy.service.
// Token tests aren't validating that interaction, so stub the surface
// to a no-op + unlimited resolution. The live module also boots Redis
// at load time, which we don't want in unit tests.
vi.mock('./spendPolicy.service.ts', () => ({
  enforceSpendPolicy: vi.fn(async () => undefined),
  enforceTokenOpCount: vi.fn(async () => undefined),
  resolvePolicy: vi.fn(async () => ({
    scope: 'unlimited' as const,
    maxXrpPerTxDrops: null,
    dailyXrpLimitDrops: null,
  })),
  SpendPolicyError: class SpendPolicyError extends Error {
    constructor(
      public readonly code: 'per_tx_limit_exceeded' | 'daily_limit_exceeded',
      message: string,
    ) {
      super(message);
      this.name = 'SpendPolicyError';
    }
  },
}));

// Import after mocks.
const {
  authorizeToken,
  clawbackToken,
  createToken,
  freezeToken,
  getToken,
  TokenServiceError,
  transferToken,
} = await import('./token.service.ts');

// ── Test helpers ────────────────────────────────────────────────────────────

const FUNDED_ISSUER = {
  id: 'acct-uuid-1',
  address: 'rIssuer0000000000000000000000000',
  isFunded: true,
};

function baseInput(overrides: Partial<Parameters<typeof createToken>[0]> = {}) {
  return {
    clientId: 'client-1',
    issuer: 'rIssuer0000000000000000000000000',
    type: 'mpt' as const,
    currencyCode: 'USD',
    transferFee: 0,
    clawback: true,
    freezeEnabled: true,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createToken', () => {
  beforeEach(() => {
    dbState.issuerRow = FUNDED_ISSUER;
    dbState.txInsertResult = [{ id: 'tx-uuid-1' }];
    dbState.tokenInsertResult = [{ id: 'token-uuid-1' }];
    dbState.txInsertCalls.length = 0;
    dbState.tokenInsertCalls.length = 0;
    enqueueCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: inserts tx row, inserts token row, enqueues TxSubmit', async () => {
    const result = await createToken(baseInput());

    // Response shape
    expect(result.id).toBe('token-uuid-1');
    expect(result.txId).toBe('tx-uuid-1');
    expect(result.status).toBe('queued');
    expect(result.mptIssuanceId).toBeNull();
    expect(result.issuerAddress).toBe(FUNDED_ISSUER.address);
    expect(result.issuerAccountId).toBe(FUNDED_ISSUER.id);
    expect(result.tokenType).toBe('mpt');
    expect(result.currencyCode).toBe('USD');

    // DB writes in the correct order.
    expect(dbState.txInsertCalls).toHaveLength(1);
    expect(dbState.tokenInsertCalls).toHaveLength(1);

    // Transactions row has the right source address + tx_type.
    const txValues = dbState.txInsertCalls[0]!.values as Record<string, unknown>;
    expect(txValues.clientId).toBe('client-1');
    expect(txValues.sourceAddress).toBe(FUNDED_ISSUER.address);
    expect(txValues.txType).toBe('MPTokenIssuanceCreate');
    expect(txValues.status).toBe('queued');
    expect(txValues.requestBody).toMatchObject({
      op: 'createToken',
      issuer: FUNDED_ISSUER.address,
      type: 'mpt',
    });

    // Tokens row references the issuer account and has mpt_issuance_id = null.
    const tokenValues = dbState.tokenInsertCalls[0]!.values as Record<string, unknown>;
    expect(tokenValues.clientId).toBe('client-1');
    expect(tokenValues.issuerAccount).toBe(FUNDED_ISSUER.id);
    expect(tokenValues.tokenType).toBe('mpt');
    expect(tokenValues.mptIssuanceId).toBeNull();

    // Enqueue received a TxSubmit payload with the right shape.
    expect(enqueueCalls).toHaveLength(1);
    const enq = enqueueCalls[0]!.data as {
      txId: string;
      sourceAddress: string;
      txJson: { TransactionType: string };
    };
    expect(enq.txId).toBe('tx-uuid-1');
    expect(enq.sourceAddress).toBe(FUNDED_ISSUER.address);
    expect(enq.txJson.TransactionType).toBe('MPTokenIssuanceCreate');
  });

  it('cross-tenant isolation: issuer belonging to another client → issuer_not_found', async () => {
    dbState.issuerRow = null; // SELECT scoped by clientId returns nothing

    const err = await createToken(baseInput()).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('issuer_not_found');

    // Critically: no tx row, no token row, no enqueue.
    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(dbState.tokenInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('issuer not yet funded → issuer_not_found (with explanatory message)', async () => {
    dbState.issuerRow = { ...FUNDED_ISSUER, isFunded: false };

    const err = await createToken(baseInput()).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('issuer_not_found');
    expect((err as Error).message).toMatch(/not yet funded/);

    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('trustline without trustlineLimit → trustline_missing_limit', async () => {
    // Sprint 3: trust line wiring is live; the validator enforces
    // trustline_limit, but the service double-checks. If the limit is
    // missing we surface a clean error code rather than building an
    // invalid TrustSet.
    const err = await createToken(baseInput({ type: 'trustline' })).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('trustline_missing_limit');

    // No side effects.
    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(dbState.tokenInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('trustline with trustlineLimit → builds TrustSet, inserts tx + token, enqueues', async () => {
    await createToken(baseInput({ type: 'trustline', trustlineLimit: '1000000' }));

    // Tx row inserted with txType=TrustSet (not MPTokenIssuanceCreate).
    expect(dbState.txInsertCalls).toHaveLength(1);
    const txRow = dbState.txInsertCalls[0]!.values as Record<string, unknown>;
    expect(txRow.txType).toBe('TrustSet');

    // Token row inserted as trustline.
    expect(dbState.tokenInsertCalls).toHaveLength(1);
    const tokenRow = dbState.tokenInsertCalls[0]!.values as Record<string, unknown>;
    expect(tokenRow.tokenType).toBe('trustline');

    // Job enqueued with a TrustSet payload.
    expect(enqueueCalls).toHaveLength(1);
    const enqData = enqueueCalls[0]!.data as Record<string, unknown>;
    const tx = enqData.txJson as Record<string, unknown>;
    expect(tx.TransactionType).toBe('TrustSet');
    expect(tx.LimitAmount).toMatchObject({ value: '1000000' });
  });

  it('passes transferFee and maxSupply through to the builder and DB', async () => {
    await createToken(baseInput({ transferFee: 250, maxSupply: '1000000000' }));

    const tokenValues = dbState.tokenInsertCalls[0]!.values as Record<string, unknown>;
    expect(tokenValues.transferFee).toBe(250);
    expect(tokenValues.maxSupply).toBe('1000000000');

    const enq = enqueueCalls[0]!.data as {
      txJson: { TransferFee?: number; MaximumAmount?: string };
    };
    expect(enq.txJson.TransferFee).toBe(250);
    expect(enq.txJson.MaximumAmount).toBe('1000000000');
  });
});

// ── Sprint 3 Sprint 2 carry-over: token operations ─────────────────────────

const MPT_ID = '00000ABC1234567890ABCDEF1234567890ABCDEF12345678';

const RESOLVED_MPT_TOKEN = {
  tokenId: 'token-1',
  tokenType: 'mpt',
  currencyCode: 'USD',
  mptIssuanceId: MPT_ID,
  issuerAccountId: 'acct-uuid-1',
  issuerAddress: 'rIssuer0000000000000000000000000',
};

const RESOLVED_TRUSTLINE_TOKEN = {
  tokenId: 'token-2',
  tokenType: 'trustline',
  currencyCode: 'USD',
  mptIssuanceId: null,
  issuerAccountId: 'acct-uuid-1',
  issuerAddress: 'rIssuer0000000000000000000000000',
};

describe('transferToken', () => {
  beforeEach(() => {
    dbState.txInsertCalls.length = 0;
    dbState.tokenInsertCalls.length = 0;
    dbState.txInsertResult = [{ id: 'tx-uuid-1' }];
    enqueueCalls.length = 0;
    dbState2.resolvedToken = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('token_not_found when JOIN returns nothing (no DB writes, no enqueue)', async () => {
    const err = await transferToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      destination: 'rDest0000000000000000000000000000',
      amount: '100',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('token_not_found');
    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('MPT happy path: builds MPT Payment, inserts tx row, enqueues', async () => {
    dbState2.resolvedToken = RESOLVED_MPT_TOKEN;

    const result = await transferToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      destination: 'rDest0000000000000000000000000000',
      amount: '100',
    });

    expect(result.txId).toBe('tx-uuid-1');
    expect(dbState.txInsertCalls).toHaveLength(1);
    const txValues = dbState.txInsertCalls[0]!.values as Record<string, unknown>;
    expect(txValues.txType).toBe('Payment');
    expect(txValues.sourceAddress).toBe(RESOLVED_MPT_TOKEN.issuerAddress);

    expect(enqueueCalls).toHaveLength(1);
    const enq = enqueueCalls[0]!.data as {
      txJson: {
        TransactionType: string;
        Amount: { mpt_issuance_id: string; value: string };
      };
    };
    expect(enq.txJson.TransactionType).toBe('Payment');
    expect(enq.txJson.Amount).toEqual({
      mpt_issuance_id: MPT_ID,
      value: '100',
    });
  });

  it('MPT token without mpt_issuance_id (not yet validated) → token_not_ready', async () => {
    dbState2.resolvedToken = { ...RESOLVED_MPT_TOKEN, mptIssuanceId: null };

    const err = await transferToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      destination: 'rDest0000000000000000000000000000',
      amount: '100',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('token_not_ready');
    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('trustline token: builds issued-currency Payment', async () => {
    dbState2.resolvedToken = RESOLVED_TRUSTLINE_TOKEN;

    await transferToken({
      clientId: 'client-1',
      tokenId: 'token-2',
      destination: 'rDest0000000000000000000000000000',
      amount: '100',
    });

    const enq = enqueueCalls[0]!.data as {
      txJson: {
        TransactionType: string;
        Amount: { currency: string; issuer: string; value: string };
      };
    };
    expect(enq.txJson.TransactionType).toBe('Payment');
    expect(enq.txJson.Amount).toEqual({
      currency: 'USD',
      issuer: RESOLVED_TRUSTLINE_TOKEN.issuerAddress,
      value: '100',
    });
  });
});

describe('freezeToken', () => {
  beforeEach(() => {
    dbState.txInsertCalls.length = 0;
    dbState.txInsertResult = [{ id: 'tx-uuid-1' }];
    enqueueCalls.length = 0;
    dbState2.resolvedToken = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('MPT happy path (lock): builds MPTokenIssuanceSet with tfMPTLock', async () => {
    dbState2.resolvedToken = RESOLVED_MPT_TOKEN;
    await freezeToken({
      clientId: 'client-1',
      tokenId: 'token-1',
    });

    const enq = enqueueCalls[0]!.data as {
      txJson: {
        TransactionType: string;
        Flags: number;
        MPTokenIssuanceID: string;
      };
    };
    expect(enq.txJson.TransactionType).toBe('MPTokenIssuanceSet');
    expect(enq.txJson.MPTokenIssuanceID).toBe(MPT_ID);
    expect(enq.txJson.Flags).toBe(1); // tfMPTLock
  });

  it('unfreeze=true → tfMPTUnlock flag', async () => {
    dbState2.resolvedToken = RESOLVED_MPT_TOKEN;
    await freezeToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      unfreeze: true,
    });
    const enq = enqueueCalls[0]!.data as { txJson: { Flags: number } };
    expect(enq.txJson.Flags).toBe(2); // tfMPTUnlock
  });

  it('includes Holder when freezing a single holder', async () => {
    dbState2.resolvedToken = RESOLVED_MPT_TOKEN;
    await freezeToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      holder: 'rHolder000000000000000000000000000',
    });
    const enq = enqueueCalls[0]!.data as { txJson: { Holder?: string } };
    expect(enq.txJson.Holder).toBe('rHolder000000000000000000000000000');
  });

  it('trustline token → invalid_input (not supported in this version)', async () => {
    dbState2.resolvedToken = RESOLVED_TRUSTLINE_TOKEN;
    const err = await freezeToken({
      clientId: 'client-1',
      tokenId: 'token-2',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('invalid_input');
    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('MPT not yet validated → token_not_ready', async () => {
    dbState2.resolvedToken = { ...RESOLVED_MPT_TOKEN, mptIssuanceId: null };
    const err = await freezeToken({
      clientId: 'client-1',
      tokenId: 'token-1',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('token_not_ready');
  });
});

describe('clawbackToken', () => {
  beforeEach(() => {
    dbState.txInsertCalls.length = 0;
    dbState.txInsertResult = [{ id: 'tx-uuid-1' }];
    enqueueCalls.length = 0;
    dbState2.resolvedToken = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('MPT happy path: builds Clawback with MPT amount + Holder', async () => {
    dbState2.resolvedToken = RESOLVED_MPT_TOKEN;
    await clawbackToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      holder: 'rHolder000000000000000000000000000',
      amount: '10',
    });

    const enq = enqueueCalls[0]!.data as {
      txJson: {
        TransactionType: string;
        Amount: { mpt_issuance_id?: string; value: string };
        Holder?: string;
      };
    };
    expect(enq.txJson.TransactionType).toBe('Clawback');
    expect(enq.txJson.Amount).toEqual({ mpt_issuance_id: MPT_ID, value: '10' });
    expect(enq.txJson.Holder).toBe('rHolder000000000000000000000000000');
  });

  it('trustline token: builds Clawback with issued-currency Amount (holder in Amount.issuer per XRPL spec)', async () => {
    dbState2.resolvedToken = RESOLVED_TRUSTLINE_TOKEN;
    await clawbackToken({
      clientId: 'client-1',
      tokenId: 'token-2',
      holder: 'rHolder000000000000000000000000000',
      amount: '10',
    });

    const enq = enqueueCalls[0]!.data as {
      txJson: {
        TransactionType: string;
        Amount: { currency?: string; issuer?: string; value: string };
      };
    };
    expect(enq.txJson.TransactionType).toBe('Clawback');
    // Per the XRPL spec, Amount.issuer carries the HOLDER address.
    expect(enq.txJson.Amount).toEqual({
      currency: 'USD',
      issuer: 'rHolder000000000000000000000000000',
      value: '10',
    });
  });

  it('token_not_found → no DB writes, no enqueue', async () => {
    const err = await clawbackToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      holder: 'rHolder000000000000000000000000000',
      amount: '10',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('token_not_found');
    expect(enqueueCalls).toHaveLength(0);
  });
});

// ── getToken (public read route) ───────────────────────────────────────────

// Exercises the tokens ↔ accounts JOIN exposed via the public getToken()
// helper. Backs the `GET /v1/tokens/:id` route. Uses the same
// dbState2.resolvedToken mock seam the token-op tests use above, but the
// row shape differs: getToken reads unaliased `id` / `clientId` / `issuerAccountId`
// directly while resolveToken uses aliased `tokenId` / `issuerAccountId`.

const RESOLVED_GET_MPT = {
  id: 'token-uuid-1',
  clientId: 'client-1',
  issuerAccountId: 'acct-uuid-1',
  issuerAddress: 'rIssuer0000000000000000000000000',
  tokenType: 'mpt',
  currencyCode: 'USD',
  mptIssuanceId: '0100029B1759FFA931B36B53EB53C7E748A79AD62AE8E103',
  transferFee: 250,
  clawback: true,
  freezeEnabled: true,
  maxSupply: null,
  createdAt: new Date('2026-04-23T12:00:00Z'),
};

describe('getToken', () => {
  beforeEach(() => {
    dbState2.resolvedToken = null;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the token does not exist / belongs to another tenant', async () => {
    // No enumeration oracle: the two cases share a return value so callers
    // can't differentiate "wrong tenant" from "wrong id".
    const out = await getToken('client-1', 'token-uuid-1');
    expect(out).toBeNull();
  });

  it('happy path: returns TokenView-shaped row with status=validated for MPT with id', async () => {
    dbState2.resolvedToken = RESOLVED_GET_MPT;

    const out = await getToken('client-1', 'token-uuid-1');
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      id: 'token-uuid-1',
      issuerAddress: RESOLVED_GET_MPT.issuerAddress,
      tokenType: 'mpt',
      currencyCode: 'USD',
      mptIssuanceId: RESOLVED_GET_MPT.mptIssuanceId,
      transferFee: 250,
      clawback: true,
      freezeEnabled: true,
      status: 'validated',
    });
    // Ensure the synthesized `status` is exposed, not the raw DB shape.
    expect(out).toHaveProperty('status');
  });

  it('MPT with null mpt_issuance_id → status=queued (not yet backfilled on-ledger)', async () => {
    dbState2.resolvedToken = { ...RESOLVED_GET_MPT, mptIssuanceId: null };

    const out = await getToken('client-1', 'token-uuid-1');
    expect(out?.status).toBe('queued');
    expect(out?.mptIssuanceId).toBeNull();
  });

  it('trustline token always reports status=validated regardless of mpt_issuance_id', async () => {
    // Trust lines don't have an mpt_issuance_id column by design — they
    // settle immediately on TrustSet so "validated" is the right read.
    dbState2.resolvedToken = {
      ...RESOLVED_GET_MPT,
      tokenType: 'trustline',
      mptIssuanceId: null,
    };

    const out = await getToken('client-1', 'token-uuid-1');
    expect(out?.tokenType).toBe('trustline');
    expect(out?.status).toBe('validated');
  });

  it('coalesces null transferFee/clawback/freezeEnabled to safe defaults', async () => {
    // Schema columns have NOT NULL DEFAULT but Drizzle's select types them
    // as nullable. Service must coalesce so the TokenView contract holds.
    dbState2.resolvedToken = {
      ...RESOLVED_GET_MPT,
      transferFee: null,
      clawback: null,
      freezeEnabled: null,
    };

    const out = await getToken('client-1', 'token-uuid-1');
    expect(out?.transferFee).toBe(0);
    expect(out?.clawback).toBe(false);
    expect(out?.freezeEnabled).toBe(false);
  });
});

// ── authorizeToken (holder MPT opt-in) ─────────────────────────────────────

// Two-stage DB lookup: resolveToken (JOIN) finds the token + issuer, then
// a plain select finds the holder account scoped to the same client. The
// holder-not-managed branch is the security-relevant one — a caller must
// NOT be able to sign an MPTokenAuthorize from an address they don't own.

describe('authorizeToken', () => {
  const HOLDER = {
    address: 'rHolder000000000000000000000000000',
    isFunded: true,
  };

  beforeEach(() => {
    dbState.issuerRow = null;
    dbState2.resolvedToken = null;
    dbState.txInsertCalls.length = 0;
    dbState.txInsertResult = [{ id: 'tx-uuid-auth' }];
    enqueueCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: signs MPTokenAuthorize from the holder with no Holder field', async () => {
    dbState2.resolvedToken = RESOLVED_MPT_TOKEN;
    dbState.issuerRow = HOLDER;

    const result = await authorizeToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      holder: HOLDER.address,
    });
    expect(result.txId).toBe('tx-uuid-auth');

    // Source address MUST be the holder (holder-side opt-in signs with
    // the holder's key, NOT the issuer's).
    const txValues = dbState.txInsertCalls[0]!.values as Record<string, unknown>;
    expect(txValues.txType).toBe('MPTokenAuthorize');
    expect(txValues.sourceAddress).toBe(HOLDER.address);

    // Enqueue payload: Account=holder, MPTokenIssuanceID=token id, no
    // Holder field (that's only used for issuer-side gating with
    // tfMPTRequireAuth issuances).
    expect(enqueueCalls).toHaveLength(1);
    const enq = enqueueCalls[0]!.data as {
      sourceAddress: string;
      txJson: {
        TransactionType: string;
        Account: string;
        MPTokenIssuanceID: string;
        Holder?: string;
        Flags?: number;
      };
    };
    expect(enq.sourceAddress).toBe(HOLDER.address);
    expect(enq.txJson.TransactionType).toBe('MPTokenAuthorize');
    expect(enq.txJson.Account).toBe(HOLDER.address);
    expect(enq.txJson.MPTokenIssuanceID).toBe(MPT_ID);
    expect(enq.txJson.Holder).toBeUndefined();
    expect(enq.txJson.Flags).toBeUndefined();
  });

  it('unauthorize=true → emits tfMPTUnauthorize flag (0x1)', async () => {
    dbState2.resolvedToken = RESOLVED_MPT_TOKEN;
    dbState.issuerRow = HOLDER;

    await authorizeToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      holder: HOLDER.address,
      unauthorize: true,
    });

    const enq = enqueueCalls[0]!.data as { txJson: { Flags?: number } };
    expect(enq.txJson.Flags).toBe(0x00000001);
  });

  it('SECURITY: holder not owned by this client → invalid_input, no enqueue', async () => {
    // Load-bearing test: without this scope check the API would let a
    // caller sign an MPTokenAuthorize from an address they don't own,
    // provided the worker's signer happened to have the key loaded.
    dbState2.resolvedToken = RESOLVED_MPT_TOKEN;
    dbState.issuerRow = null; // holder lookup scoped to clientId returns nothing

    const err = await authorizeToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      holder: 'rOtherTenantHolder00000000000000000',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('invalid_input');

    // Critically: nothing written, nothing enqueued. No side effects at all
    // when the holder isn't ours.
    expect(dbState.txInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("holder unfunded → invalid_input (can't submit any tx from a 0-XRP account)", async () => {
    dbState2.resolvedToken = RESOLVED_MPT_TOKEN;
    dbState.issuerRow = { ...HOLDER, isFunded: false };

    const err = await authorizeToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      holder: HOLDER.address,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('invalid_input');
    expect(enqueueCalls).toHaveLength(0);
  });

  it('token_not_found when the JOIN returns nothing', async () => {
    dbState2.resolvedToken = null;
    dbState.issuerRow = HOLDER;

    const err = await authorizeToken({
      clientId: 'client-1',
      tokenId: 'nonexistent',
      holder: HOLDER.address,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('token_not_found');
    expect(enqueueCalls).toHaveLength(0);
  });

  it('rejects trustline tokens with invalid_input (wrong primitive — use TrustSet)', async () => {
    dbState2.resolvedToken = RESOLVED_TRUSTLINE_TOKEN;
    dbState.issuerRow = HOLDER;

    const err = await authorizeToken({
      clientId: 'client-1',
      tokenId: 'token-2',
      holder: HOLDER.address,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('invalid_input');
    expect(enqueueCalls).toHaveLength(0);
  });

  it("token_not_ready when mpt_issuance_id is null (issuance hasn't validated)", async () => {
    dbState2.resolvedToken = { ...RESOLVED_MPT_TOKEN, mptIssuanceId: null };
    dbState.issuerRow = HOLDER;

    const err = await authorizeToken({
      clientId: 'client-1',
      tokenId: 'token-1',
      holder: HOLDER.address,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenServiceError);
    expect((err as InstanceType<typeof TokenServiceError>).code).toBe('token_not_ready');
    expect(enqueueCalls).toHaveLength(0);
  });
});

// ── MPT flag mapping (createToken → buildMptIssuanceCreate) ────────────────

// Regression guard for the `0x01 claimed to be tfMPTCanLock` bug that
// rippled rejected with temINVALID_FLAG. Correct values per xrpl.js v4.6:
//   tfMPTCanTransfer  = 0x20 (always set)
//   tfMPTCanLock      = 0x02 (set iff freeze_enabled)
//   tfMPTCanClawback  = 0x40 (set iff clawback)

describe('createToken MPT flag mapping', () => {
  beforeEach(() => {
    dbState.issuerRow = FUNDED_ISSUER;
    dbState.txInsertResult = [{ id: 'tx-uuid-1' }];
    dbState.tokenInsertResult = [{ id: 'token-uuid-1' }];
    dbState.txInsertCalls.length = 0;
    dbState.tokenInsertCalls.length = 0;
    enqueueCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clawback=true + freeze=true → 0x20 | 0x02 | 0x40 = 0x62 (98)', async () => {
    await createToken(baseInput({ clawback: true, freezeEnabled: true }));
    const enq = enqueueCalls[0]!.data as { txJson: { Flags?: number } };
    expect(enq.txJson.Flags).toBe(0x62);
  });

  it('clawback=false + freeze=false → 0x20 (tfMPTCanTransfer only)', async () => {
    await createToken(baseInput({ clawback: false, freezeEnabled: false }));
    const enq = enqueueCalls[0]!.data as { txJson: { Flags?: number } };
    expect(enq.txJson.Flags).toBe(0x20);
  });

  it('clawback=true + freeze=false → 0x20 | 0x40 = 0x60 (no CanLock bit)', async () => {
    await createToken(baseInput({ clawback: true, freezeEnabled: false }));
    const enq = enqueueCalls[0]!.data as { txJson: { Flags?: number } };
    expect(enq.txJson.Flags).toBe(0x60);
  });

  it('clawback=false + freeze=true → 0x20 | 0x02 = 0x22 (no Clawback bit)', async () => {
    await createToken(baseInput({ clawback: false, freezeEnabled: true }));
    const enq = enqueueCalls[0]!.data as { txJson: { Flags?: number } };
    expect(enq.txJson.Flags).toBe(0x22);
  });

  it('REGRESSION: flag mask never contains 0x01 (invalid on MPTokenIssuanceCreate)', async () => {
    // rippled rejects temINVALID_FLAG if any bit outside the Create flag
    // set is on. 0x01 is tfMPTLock on MPTokenIssuanceSet (the FREEZE op),
    // not a Create flag. Earlier code incorrectly OR'd 0x01 in and every
    // MPT issuance failed. This test is the guard against that regression.
    for (const combo of [
      { clawback: false, freezeEnabled: false },
      { clawback: true, freezeEnabled: false },
      { clawback: false, freezeEnabled: true },
      { clawback: true, freezeEnabled: true },
    ]) {
      enqueueCalls.length = 0;
      dbState.txInsertCalls.length = 0;
      dbState.tokenInsertCalls.length = 0;
      await createToken(baseInput(combo));
      const enq = enqueueCalls[0]!.data as { txJson: { Flags?: number } };
      expect(enq.txJson.Flags ?? 0).not.toBe(0);
      expect(((enq.txJson.Flags ?? 0) & 0x01) === 0).toBe(true);
    }
  });
});
