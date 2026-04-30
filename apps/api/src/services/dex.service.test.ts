// Unit tests for dex.service.ts (Sprint 6 — XRPL native DEX).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbInsertCalls: Array<{ table: string; values: unknown }> = [];
const dbSelectResult = { current: [] as unknown[] };

vi.mock('@railforge/db', () => {
  const insert = vi.fn((table: { __name: string }) => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ table: table.__name, values: v });
        if (table.__name === 'transactions') return [{ id: 'tx-uuid-1' }];
        return [];
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
      accounts: { __name: 'accounts' },
      transactions: { __name: 'transactions' },
    },
    eq: vi.fn(),
    and: vi.fn(),
    isNull: vi.fn(),
  };
});

vi.mock('@railforge/jobs', () => ({
  enqueueTxSubmit: vi.fn(async () => {}),
}));

vi.mock('./spendPolicy.service.ts', () => ({
  enforceSpendPolicy: vi.fn(async () => {}),
  enforceTokenOpCount: vi.fn(async () => {}),
}));

vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  },
}));

// Oracle stub — DEX tests don't validate cents conversion. Identity rate
// keeps the cap-math fixtures meaningful (drops in == drops out as cents).
vi.mock('./priceOracle.service.ts', () => ({
  dropsToUsdCents: vi.fn(async (drops: string | bigint) =>
    typeof drops === 'bigint' ? drops : BigInt(drops),
  ),
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { createOffer, cancelOffer, ammDeposit, ammWithdraw } = await import('./dex.service.ts');

describe('DexService', () => {
  beforeEach(() => {
    dbInsertCalls.length = 0;
    // Default: account is managed
    dbSelectResult.current = [{ id: 'acct-1', address: 'rOwner' }];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── createOffer ───────────────────────────────────────────────────────

  describe('createOffer', () => {
    it('enqueues an OfferCreate tx', async () => {
      const result = await createOffer({
        clientId: 'client-1',
        account: 'rOwner',
        takerGets: { drops: '1000000' },
        takerPays: { currency: 'USD', issuer: 'rIssuer', value: '10' },
      });
      expect(result.tx_id).toBe('tx-uuid-1');
      expect(result.status).toBe('queued');
      const txInsert = dbInsertCalls.find((c) => c.table === 'transactions');
      expect(txInsert?.values).toMatchObject({ txType: 'OfferCreate' });
    });

    it('throws not_managed for unknown account', async () => {
      dbSelectResult.current = [];
      await expect(
        createOffer({
          clientId: 'client-1',
          account: 'rUnknown',
          takerGets: { drops: '1000000' },
          takerPays: { currency: 'USD', issuer: 'rIssuer', value: '10' },
        }),
      ).rejects.toThrow(/not a managed account/);
    });
  });

  // ── cancelOffer ───────────────────────────────────────────────────────

  describe('cancelOffer', () => {
    it('enqueues an OfferCancel tx', async () => {
      const result = await cancelOffer({
        clientId: 'client-1',
        account: 'rOwner',
        offerSequence: 42,
      });
      expect(result.tx_id).toBe('tx-uuid-1');
      expect(result.status).toBe('queued');
      const txInsert = dbInsertCalls.find((c) => c.table === 'transactions');
      expect(txInsert?.values).toMatchObject({ txType: 'OfferCancel' });
    });
  });

  // ── ammDeposit ────────────────────────────────────────────────────────

  describe('ammDeposit', () => {
    it('enqueues an AMMDeposit tx', async () => {
      const result = await ammDeposit({
        clientId: 'client-1',
        account: 'rOwner',
        asset: { drops: '0' },
        asset2: { currency: 'USD', issuer: 'rIssuer' },
        amount: { drops: '5000000' },
        flags: 524288,
      });
      expect(result.tx_id).toBe('tx-uuid-1');
      expect(result.status).toBe('queued');
      const txInsert = dbInsertCalls.find((c) => c.table === 'transactions');
      expect(txInsert?.values).toMatchObject({ txType: 'AMMDeposit' });
    });
  });

  // ── ammWithdraw ───────────────────────────────────────────────────────

  describe('ammWithdraw', () => {
    it('enqueues an AMMWithdraw tx', async () => {
      const result = await ammWithdraw({
        clientId: 'client-1',
        account: 'rOwner',
        asset: { drops: '0' },
        asset2: { currency: 'USD', issuer: 'rIssuer' },
        amount: { drops: '3000000' },
        flags: 524288,
      });
      expect(result.tx_id).toBe('tx-uuid-1');
      expect(result.status).toBe('queued');
      const txInsert = dbInsertCalls.find((c) => c.table === 'transactions');
      expect(txInsert?.values).toMatchObject({ txType: 'AMMWithdraw' });
    });

    it('throws not_managed for unknown account', async () => {
      dbSelectResult.current = [];
      await expect(
        ammWithdraw({
          clientId: 'client-1',
          account: 'rUnknown',
          asset: { drops: '0' },
          asset2: { currency: 'USD', issuer: 'rIssuer' },
        }),
      ).rejects.toThrow(/not a managed account/);
    });
  });
});
