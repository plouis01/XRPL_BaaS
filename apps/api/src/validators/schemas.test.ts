// Unit tests for Zod schema refinements. These catch the subtle rules that
// live inside `.refine()` calls and are easy to regress when schemas grow.
//
// Focus: Sprint 6 DEX schema + permission schema — the ones most likely to
// be misused at the API boundary.

import { describe, expect, it } from 'vitest';
import {
  ammDepositSchema,
  ammWithdrawSchema,
  cancelOfferSchema,
  createOfferSchema,
  grantPermissionSchema,
} from './schemas.ts';

// Real XRPL addresses (validated by the xrplAddressSchema regex).
const ADDR_A = 'rNQEkWHbK1DCz9xBpA2eZhFm2ukFHsqFGq';
const ADDR_B = 'rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd';

describe('createOfferSchema', () => {
  // The S6-7 refine: flags must be a combination of the 4 known OfferCreate
  // flag bits — tfPassive (65536), tfImmediateOrCancel (131072),
  // tfFillOrKill (262144), tfSell (524288). Any other bit is rejected.
  const tfPassive = 65536;
  const tfImmediateOrCancel = 131072;
  const tfFillOrKill = 262144;
  const tfSell = 524288;
  const validMask = tfPassive | tfImmediateOrCancel | tfFillOrKill | tfSell;

  const baseBody = {
    account: ADDR_A,
    taker_gets: { drops: '1000000' },
    taker_pays: { currency: 'USD', issuer: ADDR_B, value: '10' },
  };

  it('accepts zero flags', () => {
    const result = createOfferSchema.safeParse({ ...baseBody, flags: 0 });
    expect(result.success).toBe(true);
  });

  it.each([
    ['tfPassive', tfPassive],
    ['tfImmediateOrCancel', tfImmediateOrCancel],
    ['tfFillOrKill', tfFillOrKill],
    ['tfSell', tfSell],
  ])('accepts a single valid flag (%s)', (_name, flag) => {
    const result = createOfferSchema.safeParse({ ...baseBody, flags: flag });
    expect(result.success).toBe(true);
  });

  it('accepts a combination of valid flags (tfPassive | tfSell)', () => {
    const result = createOfferSchema.safeParse({
      ...baseBody,
      flags: tfPassive | tfSell,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the full valid bitmask', () => {
    const result = createOfferSchema.safeParse({
      ...baseBody,
      flags: validMask,
    });
    expect(result.success).toBe(true);
  });

  it('rejects bit 1 (not a valid OfferCreate flag)', () => {
    const result = createOfferSchema.safeParse({ ...baseBody, flags: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a valid flag combined with an unknown bit', () => {
    // tfPassive + bit 0 = 65537. The unknown bit must flag the schema as invalid.
    const result = createOfferSchema.safeParse({
      ...baseBody,
      flags: tfPassive | 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a high-bit value not in the mask (e.g. 0x80000000)', () => {
    const result = createOfferSchema.safeParse({
      ...baseBody,
      flags: 0x80000000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative flags via min(0)', () => {
    const result = createOfferSchema.safeParse({ ...baseBody, flags: -1 });
    expect(result.success).toBe(false);
  });

  it('omitting flags is valid (optional)', () => {
    const result = createOfferSchema.safeParse(baseBody);
    expect(result.success).toBe(true);
  });
});

describe('cancelOfferSchema', () => {
  it('accepts a valid offer_sequence', () => {
    const result = cancelOfferSchema.safeParse({
      account: ADDR_A,
      offer_sequence: 42,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative offer_sequence', () => {
    const result = cancelOfferSchema.safeParse({
      account: ADDR_A,
      offer_sequence: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('ammDepositSchema / ammWithdrawSchema', () => {
  const baseAmmBody = {
    account: ADDR_A,
    asset: { drops: true as const },
    asset2: { currency: 'USD', issuer: ADDR_B },
  };

  it('accepts minimal AMM deposit body', () => {
    const result = ammDepositSchema.safeParse(baseAmmBody);
    expect(result.success).toBe(true);
  });

  it('accepts AMM deposit with lp_token_out', () => {
    const result = ammDepositSchema.safeParse({
      ...baseAmmBody,
      lp_token_out: { currency: 'LP', issuer: ADDR_B, value: '100' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal AMM withdraw body', () => {
    const result = ammWithdrawSchema.safeParse(baseAmmBody);
    expect(result.success).toBe(true);
  });

  it('rejects asset with both drops and currency (not exactly one)', () => {
    const result = ammDepositSchema.safeParse({
      account: ADDR_A,
      asset: { drops: true, currency: 'USD', issuer: ADDR_B },
      asset2: { currency: 'USD', issuer: ADDR_B },
    });
    expect(result.success).toBe(false);
  });
});

describe('grantPermissionSchema', () => {
  it('accepts a valid grant body', () => {
    const result = grantPermissionSchema.safeParse({
      delegator_address: ADDR_A,
      delegate_address: ADDR_B,
      permissions: ['Payment', 'TrustSet'],
      weight: 5,
    });
    expect(result.success).toBe(true);
  });

  it('defaults weight to 1 when omitted', () => {
    const result = grantPermissionSchema.parse({
      delegator_address: ADDR_A,
      delegate_address: ADDR_B,
      permissions: ['Payment'],
    });
    expect(result.weight).toBe(1);
  });

  it('rejects an unknown permission value', () => {
    const result = grantPermissionSchema.safeParse({
      delegator_address: ADDR_A,
      delegate_address: ADDR_B,
      permissions: ['NotARealPermission'],
      weight: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 10 permissions (XLS-75 limit)', () => {
    const result = grantPermissionSchema.safeParse({
      delegator_address: ADDR_A,
      delegate_address: ADDR_B,
      permissions: Array(11).fill('Payment'),
      weight: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty permissions array', () => {
    const result = grantPermissionSchema.safeParse({
      delegator_address: ADDR_A,
      delegate_address: ADDR_B,
      permissions: [],
      weight: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects weight > 65535', () => {
    const result = grantPermissionSchema.safeParse({
      delegator_address: ADDR_A,
      delegate_address: ADDR_B,
      permissions: ['Payment'],
      weight: 70000,
    });
    expect(result.success).toBe(false);
  });
});
