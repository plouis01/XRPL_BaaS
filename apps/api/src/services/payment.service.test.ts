// Unit tests for payment.service.ts.
//
// Coverage:
//   1. sendPayment: XRP happy path, MPT happy path, issued-currency happy path
//   2. sendPayment: source_not_found (cross-tenant isolation)
//   3. sendPayment: source_not_funded
//   4. sendPayment: invalid_input (no amount group)
//   5. getPayment: returns row for matching client, null for mismatch
//   6. createEscrow: happy path, invalid_input wraps builder error
//   7. finishEscrow: happy path
//   8. cancelEscrow: happy path

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbSelectResult = { current: [] as unknown[] };
const dbInsertCalls: Array<{ values: unknown }> = [];
const dbInsertResult = { current: [{ id: 'tx-uuid-1' }] as unknown[] };

vi.mock('@railforge/db', () => {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => dbSelectResult.current),
      })),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ values: v });
        return dbInsertResult.current;
      }),
    })),
  }));
  return {
    db: { select, insert },
    schema: {
      accounts: {
        id: 'id',
        clientId: 'clientId',
        address: 'address',
        isFunded: 'isFunded',
        deletedAt: 'deletedAt',
      },
      transactions: {
        id: 'id',
        clientId: 'clientId',
        txType: 'txType',
        sourceAddress: 'sourceAddress',
        status: 'status',
        resultCode: 'resultCode',
        txHash: 'txHash',
        ledgerIndex: 'ledgerIndex',
        feeDrops: 'feeDrops',
        createdAt: 'createdAt',
        submittedAt: 'submittedAt',
        confirmedAt: 'confirmedAt',
      },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
  };
});

// ── jobs mock ───────────────────────────────────────────────────────────────

const enqueueCalls: Array<unknown> = [];
vi.mock('@railforge/jobs', () => ({
  enqueueTxSubmit: vi.fn(async (data: unknown) => {
    enqueueCalls.push(data);
  }),
}));

vi.mock('./spendPolicy.service.ts', () => ({
  enforceSpendPolicy: vi.fn(async () => {}),
}));

// Import after mocks.
const { PaymentServiceError, cancelEscrow, createEscrow, finishEscrow, getPayment, sendPayment } =
  await import('./payment.service.ts');

// ── Fixtures ────────────────────────────────────────────────────────────────

const FUNDED_SOURCE = {
  id: 'acct-1',
  address: 'rSource0000000000000000000000000',
  isFunded: true,
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('sendPayment', () => {
  beforeEach(() => {
    dbSelectResult.current = [FUNDED_SOURCE];
    dbInsertCalls.length = 0;
    dbInsertResult.current = [{ id: 'tx-uuid-1' }];
    enqueueCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('XRP happy path: builds XRP Payment, inserts tx, enqueues', async () => {
    const result = await sendPayment({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      amountDrops: '1000000',
    });
    expect(result.txId).toBe('tx-uuid-1');
    expect(dbInsertCalls).toHaveLength(1);
    const txValues = dbInsertCalls[0]!.values as Record<string, unknown>;
    expect(txValues.txType).toBe('Payment');

    const enq = enqueueCalls[0] as {
      txJson: { TransactionType: string; Amount: unknown };
    };
    expect(enq.txJson.TransactionType).toBe('Payment');
    expect(enq.txJson.Amount).toBe('1000000');
  });

  it('MPT happy path: builds MPT Payment', async () => {
    await sendPayment({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      mptIssuanceId: '00ABCDEF1234',
      value: '100',
    });
    const enq = enqueueCalls[0] as {
      txJson: { Amount: { mpt_issuance_id: string; value: string } };
    };
    expect(enq.txJson.Amount).toEqual({
      mpt_issuance_id: '00ABCDEF1234',
      value: '100',
    });
  });

  it('issued-currency happy path: builds issued-currency Payment', async () => {
    await sendPayment({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      currency: 'USD',
      issuer: 'rIssuer0000000000000000000000000',
      value: '50',
    });
    const enq = enqueueCalls[0] as {
      txJson: { Amount: { currency: string; issuer: string; value: string } };
    };
    expect(enq.txJson.Amount).toEqual({
      currency: 'USD',
      issuer: 'rIssuer0000000000000000000000000',
      value: '50',
    });
  });

  it('source_not_found when account lookup returns empty', async () => {
    dbSelectResult.current = [];
    const err = await sendPayment({
      clientId: 'client-1',
      source: 'rUnknown',
      destination: 'rDest0000000000000000000000000000',
      amountDrops: '100',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentServiceError);
    expect((err as InstanceType<typeof PaymentServiceError>).code).toBe('source_not_found');
    expect(dbInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('source_not_funded when account is not yet funded', async () => {
    dbSelectResult.current = [{ ...FUNDED_SOURCE, isFunded: false }];
    const err = await sendPayment({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      amountDrops: '100',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentServiceError);
    expect((err as InstanceType<typeof PaymentServiceError>).code).toBe('source_not_funded');
  });

  it('invalid_input when no amount group is provided', async () => {
    const err = await sendPayment({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      // no amount_drops, no mpt_issuance_id+value, no currency+issuer+value
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentServiceError);
    expect((err as InstanceType<typeof PaymentServiceError>).code).toBe('invalid_input');
  });
});

describe('getPayment', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the payment view for a matching client+id', async () => {
    dbSelectResult.current = [
      {
        id: 'tx-1',
        txType: 'Payment',
        sourceAddress: 'rSource',
        status: 'validated',
        resultCode: 'tesSUCCESS',
        txHash: 'ABC',
        ledgerIndex: 100,
        feeDrops: '12',
        createdAt: new Date(),
        submittedAt: new Date(),
        confirmedAt: new Date(),
      },
    ];
    const result = await getPayment('client-1', 'tx-1');
    expect(result).not.toBeNull();
    expect(result?.status).toBe('validated');
  });

  it('returns null when no row matches', async () => {
    dbSelectResult.current = [];
    const result = await getPayment('client-1', 'tx-unknown');
    expect(result).toBeNull();
  });
});

describe('createEscrow', () => {
  beforeEach(() => {
    dbSelectResult.current = [FUNDED_SOURCE];
    dbInsertCalls.length = 0;
    dbInsertResult.current = [{ id: 'tx-uuid-1' }];
    enqueueCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: builds EscrowCreate, inserts tx, enqueues', async () => {
    const result = await createEscrow({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      amountDrops: '1000000',
      finishAfter: 800000000,
    });
    expect(result.txId).toBe('tx-uuid-1');
    const enq = enqueueCalls[0] as {
      txJson: { TransactionType: string; FinishAfter: number };
    };
    expect(enq.txJson.TransactionType).toBe('EscrowCreate');
    expect(enq.txJson.FinishAfter).toBe(800000000);
  });

  it('invalid_input wraps builder validation error', async () => {
    const err = await createEscrow({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      amountDrops: '100',
      // neither finishAfter nor cancelAfter → builder throws
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentServiceError);
    expect((err as InstanceType<typeof PaymentServiceError>).code).toBe('invalid_input');
  });
});

describe('finishEscrow', () => {
  beforeEach(() => {
    dbSelectResult.current = [FUNDED_SOURCE];
    dbInsertCalls.length = 0;
    dbInsertResult.current = [{ id: 'tx-uuid-1' }];
    enqueueCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: builds EscrowFinish, inserts tx, enqueues', async () => {
    const result = await finishEscrow({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      owner: 'rOwner000000000000000000000000000',
      offerSequence: 42,
    });
    expect(result.txId).toBe('tx-uuid-1');
    const enq = enqueueCalls[0] as {
      txJson: { TransactionType: string; Owner: string; OfferSequence: number };
    };
    expect(enq.txJson.TransactionType).toBe('EscrowFinish');
    expect(enq.txJson.Owner).toBe('rOwner000000000000000000000000000');
    expect(enq.txJson.OfferSequence).toBe(42);
  });
});

describe('cancelEscrow', () => {
  beforeEach(() => {
    dbSelectResult.current = [FUNDED_SOURCE];
    dbInsertCalls.length = 0;
    dbInsertResult.current = [{ id: 'tx-uuid-1' }];
    enqueueCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: builds EscrowCancel, inserts tx, enqueues', async () => {
    const result = await cancelEscrow({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      owner: 'rOwner000000000000000000000000000',
      offerSequence: 42,
    });
    expect(result.txId).toBe('tx-uuid-1');
    const enq = enqueueCalls[0] as {
      txJson: { TransactionType: string; OfferSequence: number };
    };
    expect(enq.txJson.TransactionType).toBe('EscrowCancel');
    expect(enq.txJson.OfferSequence).toBe(42);
  });
});
