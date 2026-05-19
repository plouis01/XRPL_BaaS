// Unit tests for x402Verify.service.ts. SPRINT_10_PLAN.md §4.3 + §6.
//
// Strategy: stub `findIntent` + `consumeIntent` from x402Intent.service and
// inject a fake ReadClient via verifyPayment's `opts.client` test seam.
// One test per failure branch + one happy-path test for XRP and one for
// MPT (post-fixMPTDeliveredAmount shape).

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

import { intentIdToDestinationTag } from '@railforge/xrpl-core';

const VALID_MPT_ID = '000004C463C52827307480341125DA0577DEFC38405B0E07';
const PAYEE = 'rEHMTjmCNgxiGzgUTpV4Y1MwYpFpYz7e7p';

// Build a real intent id so intentIdToDestinationTag(intent.id) — the
// defense-in-depth recompute in the verifier — matches the row's tag.
const TEST_INTENT_ID = 'x402_intent_ABCDEFGHJKMNPQRSTVWXYZ0123';
const TEST_TAG = intentIdToDestinationTag(TEST_INTENT_ID);

interface FakeIntent {
  id: string;
  clientId: string | null;
  resourcePath: string;
  payeeAddress: string;
  assetKind: 'xrp' | 'mpt';
  assetKey: string | null;
  amount: string;
  destinationTag: number;
  expiresAt: Date;
  consumedAt: Date | null;
  consumingTxHash: string | null;
  createdAt: Date;
}

function baseXrpIntent(overrides: Partial<FakeIntent> = {}): FakeIntent {
  return {
    id: TEST_INTENT_ID,
    clientId: null,
    resourcePath: '/v1/x402-demo/echo',
    payeeAddress: PAYEE,
    assetKind: 'xrp',
    assetKey: null,
    amount: '10000',
    destinationTag: TEST_TAG,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    consumingTxHash: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function baseMptIntent(overrides: Partial<FakeIntent> = {}): FakeIntent {
  return baseXrpIntent({
    assetKind: 'mpt',
    assetKey: VALID_MPT_ID,
    amount: '42',
    ...overrides,
  });
}

// Stateful stubs that each test rewires.
const stubs = {
  intent: null as FakeIntent | null,
  consumeReturns: true as boolean,
  consumeCalls: [] as Array<{ intentId: string; txHash: string }>,
};

vi.mock('./x402Intent.service.ts', async () => {
  const actual =
    await vi.importActual<typeof import('./x402Intent.service.ts')>('./x402Intent.service.ts');
  return {
    ...actual,
    findIntent: vi.fn(async () => stubs.intent),
    consumeIntent: vi.fn(async (intentId: string, txHash: string) => {
      stubs.consumeCalls.push({ intentId, txHash });
      return stubs.consumeReturns;
    }),
  };
});

vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// readClient is exercised via the opts.client seam, so a getReadClient
// stub is only needed when no opts.client is provided. Default the
// stub to throwing so any test that forgets to inject is caught loud.
vi.mock('../xrpl/readClient.ts', () => ({
  getReadClient: vi.fn(async () => {
    throw new Error('test must pass opts.client');
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const TX_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Build a fake ReadClient that returns a static `result` shape.
function fakeClient(result: unknown) {
  return {
    request: vi.fn(async () => ({ result })),
  };
}

function failingClient(err: unknown) {
  return {
    request: vi.fn(async () => {
      throw err;
    }),
  };
}

// Canonical tx shape — adjust per-test by mutating before passing in.
function makeXrpTx(
  overrides: Partial<{
    validated: boolean;
    result: string;
    transactionType: string;
    destination: string;
    destinationTag: number;
    deliveredAmount: unknown;
  }> = {},
): Record<string, unknown> {
  return {
    validated: overrides.validated ?? true,
    ledger_index: 12345,
    tx_json: {
      TransactionType: overrides.transactionType ?? 'Payment',
      Destination: overrides.destination ?? PAYEE,
      DestinationTag: overrides.destinationTag ?? TEST_TAG,
      Amount: '10000',
    },
    meta: {
      TransactionResult: overrides.result ?? 'tesSUCCESS',
      delivered_amount: overrides.deliveredAmount ?? '10000',
    },
  };
}

function makeMptTx(
  overrides: Partial<{
    deliveredId: string;
    deliveredValue: string;
  }> = {},
): Record<string, unknown> {
  return {
    validated: true,
    ledger_index: 99,
    tx_json: {
      TransactionType: 'Payment',
      Destination: PAYEE,
      DestinationTag: TEST_TAG,
      Amount: { mpt_issuance_id: VALID_MPT_ID, value: '42' },
    },
    meta: {
      TransactionResult: 'tesSUCCESS',
      delivered_amount: {
        mpt_issuance_id: overrides.deliveredId ?? VALID_MPT_ID,
        value: overrides.deliveredValue ?? '42',
      },
    },
  };
}

// Import after mocks so the service binds to the mocked findIntent /
// consumeIntent.
import { verifyPayment } from './x402Verify.service.ts';

beforeEach(() => {
  stubs.intent = null;
  stubs.consumeReturns = true;
  stubs.consumeCalls = [];
});

// ── Lifecycle failures (steps 1–3) ─────────────────────────────────────────

describe('verifyPayment — lifecycle', () => {
  it('returns not_found for unknown intent', async () => {
    stubs.intent = null;
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx()),
    });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns already_consumed when consumedAt is set', async () => {
    stubs.intent = baseXrpIntent({ consumedAt: new Date() });
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx()),
    });
    expect(res).toEqual({ ok: false, reason: 'already_consumed' });
  });

  it('returns expired when expiresAt is in the past', async () => {
    stubs.intent = baseXrpIntent({ expiresAt: new Date(Date.now() - 1000) });
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx()),
    });
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });
});

// ── Tx-fetch failures (step 4–5) ───────────────────────────────────────────

describe('verifyPayment — tx fetch / validation', () => {
  it('returns tx_lookup_failed when rippled request throws', async () => {
    stubs.intent = baseXrpIntent();
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: failingClient(new Error('rippled timeout')),
    });
    expect(res).toEqual({ ok: false, reason: 'tx_lookup_failed' });
  });

  it('returns not_validated when validated=false', async () => {
    stubs.intent = baseXrpIntent();
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx({ validated: false })),
    });
    expect(res).toEqual({ ok: false, reason: 'not_validated' });
  });

  it('returns not_validated when result is tec-coded (on-ledger failure)', async () => {
    stubs.intent = baseXrpIntent();
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx({ result: 'tecPATH_DRY' })),
    });
    expect(res).toEqual({ ok: false, reason: 'not_validated' });
  });
});

// ── Tx-shape failures (steps 6–7) ──────────────────────────────────────────

describe('verifyPayment — tx shape', () => {
  it('returns not_payment for non-Payment tx types', async () => {
    stubs.intent = baseXrpIntent();
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx({ transactionType: 'OfferCreate' })),
    });
    expect(res).toEqual({ ok: false, reason: 'not_payment' });
  });

  it('returns payee_mismatch when Destination differs', async () => {
    stubs.intent = baseXrpIntent();
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx({ destination: 'rImposter1111111111111111111111111' })),
    });
    expect(res).toEqual({ ok: false, reason: 'payee_mismatch' });
  });

  it('returns tag_mismatch when DestinationTag differs', async () => {
    stubs.intent = baseXrpIntent();
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx({ destinationTag: TEST_TAG + 1 })),
    });
    expect(res).toEqual({ ok: false, reason: 'tag_mismatch' });
  });
});

// ── Asset / amount checks (step 8) ─────────────────────────────────────────

describe('verifyPayment — XRP asset & amount', () => {
  it('returns asset_mismatch when delivered_amount is an MPT object on an XRP intent', async () => {
    stubs.intent = baseXrpIntent();
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(
        makeXrpTx({
          deliveredAmount: { mpt_issuance_id: VALID_MPT_ID, value: '10000' },
        }),
      ),
    });
    expect(res).toEqual({ ok: false, reason: 'asset_mismatch' });
  });

  it('returns amount_short when delivered_amount < intent.amount', async () => {
    stubs.intent = baseXrpIntent({ amount: '10000' });
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx({ deliveredAmount: '9999' })),
    });
    expect(res).toEqual({ ok: false, reason: 'amount_short' });
  });

  it('accepts when delivered_amount == intent.amount', async () => {
    stubs.intent = baseXrpIntent({ amount: '10000' });
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx({ deliveredAmount: '10000' })),
    });
    expect(res.ok).toBe(true);
  });

  it('accepts when delivered_amount > intent.amount (overpay)', async () => {
    stubs.intent = baseXrpIntent({ amount: '10000' });
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx({ deliveredAmount: '99999' })),
    });
    expect(res.ok).toBe(true);
  });
});

describe('verifyPayment — MPT asset & amount', () => {
  it('accepts canonical post-fixMPTDeliveredAmount shape', async () => {
    stubs.intent = baseMptIntent();
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeMptTx()),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ledgerIndex).toBe(99);
      expect(res.intent.consumingTxHash).toBe(TX_HASH);
    }
  });

  it('rejects when mpt_issuance_id differs from intent.assetKey', async () => {
    stubs.intent = baseMptIntent();
    const otherId = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeMptTx({ deliveredId: otherId })),
    });
    expect(res).toEqual({ ok: false, reason: 'asset_mismatch' });
  });

  it('rejects when MPT value is short of intent.amount', async () => {
    stubs.intent = baseMptIntent({ amount: '100' });
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeMptTx({ deliveredValue: '50' })),
    });
    expect(res).toEqual({ ok: false, reason: 'amount_short' });
  });

  it('normalises mpt_issuance_id case (lower-case on tx still matches)', async () => {
    stubs.intent = baseMptIntent();
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeMptTx({ deliveredId: VALID_MPT_ID.toLowerCase() })),
    });
    expect(res.ok).toBe(true);
  });

  it('rejects MPT delivered as a string (would indicate wrong shape)', async () => {
    stubs.intent = baseMptIntent();
    const tx = makeMptTx();
    (tx.meta as Record<string, unknown>).delivered_amount = '42';
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(tx),
    });
    expect(res).toEqual({ ok: false, reason: 'asset_mismatch' });
  });
});

// ── Atomic claim (step 9) ──────────────────────────────────────────────────

describe('verifyPayment — atomic claim', () => {
  it('returns already_consumed when consumeIntent loses the race', async () => {
    stubs.intent = baseXrpIntent();
    stubs.consumeReturns = false;
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx()),
    });
    expect(res).toEqual({ ok: false, reason: 'already_consumed' });
  });

  it('calls consumeIntent(intentId, txHash) on success', async () => {
    stubs.intent = baseXrpIntent();
    await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(makeXrpTx()),
    });
    expect(stubs.consumeCalls).toEqual([{ intentId: TEST_INTENT_ID, txHash: TX_HASH }]);
  });
});

// ── v1 tx shape compatibility ───────────────────────────────────────────────

describe('verifyPayment — v1 / v2 tx shape compatibility', () => {
  it('reads top-level fields when tx_json is absent (v1 shape)', async () => {
    stubs.intent = baseXrpIntent();
    const v1Tx = {
      validated: true,
      ledger_index: 1,
      TransactionType: 'Payment',
      Destination: PAYEE,
      DestinationTag: TEST_TAG,
      Amount: '10000',
      meta: {
        TransactionResult: 'tesSUCCESS',
        delivered_amount: '10000',
      },
    };
    const res = await verifyPayment(TEST_INTENT_ID, TX_HASH, {
      client: fakeClient(v1Tx),
    });
    expect(res.ok).toBe(true);
  });
});
