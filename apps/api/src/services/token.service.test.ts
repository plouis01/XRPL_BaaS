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

// Import after mocks.
const { clawbackToken, createToken, freezeToken, TokenServiceError, transferToken } = await import(
  './token.service.ts'
);

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
