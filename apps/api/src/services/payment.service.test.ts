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
  enforceTokenOpCount: vi.fn(async () => {}),
}));

// VISION.md agent launcher: stub authorizeAgentPayment so the gated-path
// tests can assert on its call without spinning up the full mock DB shape.
// The default is a no-op (resolves); individual tests opt into a rejection.
const authorizeAgentPaymentMock = vi.fn(async (_input: unknown) => {});
vi.mock('./agent.service.ts', () => ({
  authorizeAgentPayment: (input: unknown) => authorizeAgentPaymentMock(input),
  AgentServiceError: class AgentServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'AgentServiceError';
    }
  },
}));

// Import after mocks.
const { PaymentServiceError, cancelEscrow, createEscrow, finishEscrow, getPayment, sendPayment } =
  await import('./payment.service.ts');
// Pull the MOCKED AgentServiceError class so the rejection test can throw
// an instance that passes payment.service's `err instanceof AgentServiceError`
// check. A plain `new Error(...)` with name='AgentServiceError' would fail
// the instanceof and bubble up instead of translating to invalid_input.
const { AgentServiceError: MockedAgentServiceError } = (await import('./agent.service.ts')) as {
  AgentServiceError: new (code: string, message: string) => Error & { code: string };
};

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

// ── VISION.md agent launcher — sendPayment gating ──────────────────────────
// These tests verify that when `agentId` is threaded in, sendPayment calls
// authorizeAgentPayment BEFORE enqueueing and propagates its rejections as
// PaymentServiceError('invalid_input') with the original agent-code message.
// The authorize helper itself is fully tested in agent.service.test.ts —
// here we only verify the integration point.

describe('sendPayment — agent gating', () => {
  beforeEach(() => {
    dbSelectResult.current = [FUNDED_SOURCE];
    dbInsertCalls.length = 0;
    dbInsertResult.current = [{ id: 'tx-uuid-agent' }];
    enqueueCalls.length = 0;
    authorizeAgentPaymentMock.mockReset();
    authorizeAgentPaymentMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('XRP payment with agentId: calls authorizeAgentPayment with no assetKey', async () => {
    const result = await sendPayment({
      clientId: 'client-1',
      agentId: 'agent-uuid-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      amountDrops: '1000000',
    });

    expect(result.txId).toBe('tx-uuid-agent');
    expect(authorizeAgentPaymentMock).toHaveBeenCalledTimes(1);
    const call = authorizeAgentPaymentMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call?.agentId).toBe('agent-uuid-1');
    expect(call?.sourceAddress).toBe(FUNDED_SOURCE.address);
    expect(call?.destinationAddress).toBe('rDest0000000000000000000000000000');
    expect(call?.assetKey).toBeNull();
  });

  it('MPT payment with agentId: assetKey is the 48-hex issuance id', async () => {
    await sendPayment({
      clientId: 'client-1',
      agentId: 'agent-uuid-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      mptIssuanceId: 'a'.repeat(48),
      value: '100',
    });
    const call = authorizeAgentPaymentMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call?.assetKey).toBe('a'.repeat(48));
  });

  it("Issued-currency payment with agentId: assetKey is '<currency>:<issuer>'", async () => {
    await sendPayment({
      clientId: 'client-1',
      agentId: 'agent-uuid-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      currency: 'USD',
      issuer: 'rIssuer00000000000000000000000000',
      value: '100',
    });
    const call = authorizeAgentPaymentMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call?.assetKey).toBe('USD:rIssuer00000000000000000000000000');
  });

  it("authorize rejection → PaymentServiceError('invalid_input'); no enqueue, no insert", async () => {
    authorizeAgentPaymentMock.mockImplementation(async () => {
      // Must be an instance of the MOCKED AgentServiceError so the service's
      // `err instanceof AgentServiceError` check takes the code-mapping
      // branch instead of rethrowing.
      throw new MockedAgentServiceError(
        'destination_not_allowlisted',
        "Destination rDest... is not on the agent's allowlist",
      );
    });

    await expect(
      sendPayment({
        clientId: 'client-1',
        agentId: 'agent-uuid-1',
        source: FUNDED_SOURCE.address,
        destination: 'rDest0000000000000000000000000000',
        amountDrops: '1000000',
      }),
    ).rejects.toMatchObject({
      name: 'PaymentServiceError',
      code: 'invalid_input',
    });

    // Gate runs BEFORE tx build / insert / enqueue — none of those fire.
    expect(dbInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('no agentId: authorize is NOT called (regular client-scoped key path)', async () => {
    await sendPayment({
      clientId: 'client-1',
      source: FUNDED_SOURCE.address,
      destination: 'rDest0000000000000000000000000000',
      amountDrops: '1000000',
    });
    expect(authorizeAgentPaymentMock).not.toHaveBeenCalled();
  });
});
