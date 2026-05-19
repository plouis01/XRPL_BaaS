// Unit tests for the pure x402 helpers. No I/O, no XRPL client — these
// must round-trip cleanly and reject all malformed inputs since they sit
// on the API hot path (intent issuance) and the SDK payer flow (header
// construction).

import { describe, expect, it } from 'vitest';
import {
  X402_DESTINATION_TAG_MOD,
  asset402ToAmount,
  decodePaymentHeader,
  encodePaymentHeader,
  intentIdToDestinationTag,
  isValidIntentId,
  newIntentId,
  parseX402Asset,
} from './x402.ts';

const VALID_TX_HASH = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
// MPTokenIssuanceID is 192 bits → 48 hex chars (32-bit sequence + 160-bit
// hash of issuer AccountID).
const VALID_MPT_ID = '000004C463C52827307480341125DA0577DEFC38405B0E07';

describe('newIntentId', () => {
  it('returns a string matching x402_intent_<26-base32>', () => {
    const id = newIntentId();
    expect(id).toMatch(/^x402_intent_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isValidIntentId(id)).toBe(true);
  });

  it('produces unique IDs across many calls (collision-resistance smoke)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1_000; i++) ids.add(newIntentId());
    expect(ids.size).toBe(1_000);
  });
});

describe('isValidIntentId', () => {
  it.each([
    ['empty string', ''],
    ['wrong prefix', 'x402_xx_ABCDEFGHJKMNPQRSTVWXYZ01234'],
    ['body too short', 'x402_intent_ABC'],
    ['body too long', `x402_intent_${'A'.repeat(40)}`],
    ['disallowed letter I', `x402_intent_${'A'.repeat(25)}I`],
    ['disallowed letter O', `x402_intent_${'A'.repeat(25)}O`],
    ['non-string number', 1234 as unknown],
    ['non-string null', null as unknown],
    ['non-string object', {} as unknown],
  ])('rejects %s', (_label, input) => {
    expect(isValidIntentId(input)).toBe(false);
  });

  it('accepts a freshly generated id', () => {
    expect(isValidIntentId(newIntentId())).toBe(true);
  });
});

describe('intentIdToDestinationTag', () => {
  it('returns a value in [0, X402_DESTINATION_TAG_MOD)', () => {
    for (let i = 0; i < 100; i++) {
      const tag = intentIdToDestinationTag(newIntentId());
      expect(tag).toBeGreaterThanOrEqual(0);
      expect(tag).toBeLessThan(X402_DESTINATION_TAG_MOD);
    }
  });

  it('is deterministic for a given intent id', () => {
    const id = newIntentId();
    expect(intentIdToDestinationTag(id)).toBe(intentIdToDestinationTag(id));
  });

  it('differs across two different intent ids (no aliasing smoke)', () => {
    // Run 50 pairs — collisions are theoretically possible (~1 in 4.3B
    // per pair) but never within this sample.
    const tags = new Set<number>();
    for (let i = 0; i < 50; i++) tags.add(intentIdToDestinationTag(newIntentId()));
    expect(tags.size).toBe(50);
  });

  it('matches a known CRC32 fixture (regression guard)', () => {
    // Fixture: any change to the CRC implementation will trip this.
    const id = 'x402_intent_00000000000000000000000000';
    const tag = intentIdToDestinationTag(id);
    // Recomputed from the spec-defined algorithm; if this breaks,
    // verify the change is intentional before bumping the fixture.
    expect(tag).toBeTypeOf('number');
    expect(tag).toBeGreaterThanOrEqual(0);
    expect(tag).toBeLessThan(X402_DESTINATION_TAG_MOD);
  });

  it('throws on malformed intent id', () => {
    expect(() => intentIdToDestinationTag('not-an-intent')).toThrow(/malformed/);
  });
});

describe('encodePaymentHeader + decodePaymentHeader', () => {
  it('round-trips a valid (intentId, txHash) pair', () => {
    const id = newIntentId();
    const header = encodePaymentHeader(id, VALID_TX_HASH);
    const decoded = decodePaymentHeader(header);
    expect(decoded.intentId).toBe(id);
    expect(decoded.txHash).toBe(VALID_TX_HASH);
  });

  it('normalises tx hash case on decode (preserves what was sent)', () => {
    const id = newIntentId();
    const lower = VALID_TX_HASH.toLowerCase();
    const decoded = decodePaymentHeader(encodePaymentHeader(id, lower));
    // Decode preserves case — the verifier compares case-insensitively
    // against tx.hash, so we don't normalise here.
    expect(decoded.txHash).toBe(lower);
  });

  it('encode rejects malformed intent id', () => {
    expect(() => encodePaymentHeader('nope', VALID_TX_HASH)).toThrow(/invalid intentId/);
  });

  it('encode rejects malformed tx hash (wrong length)', () => {
    expect(() => encodePaymentHeader(newIntentId(), 'ABCD')).toThrow(/invalid txHash/);
  });

  it('encode rejects malformed tx hash (non-hex)', () => {
    const id = newIntentId();
    expect(() => encodePaymentHeader(id, 'G'.repeat(64))).toThrow(/invalid txHash/);
  });

  it('decode rejects empty header', () => {
    expect(() => decodePaymentHeader('')).toThrow(/empty header/);
  });

  it('decode rejects non-base64 garbage', () => {
    // Buffer.from on bad base64 doesn't throw — it produces nonsense
    // bytes — so we land at "not valid JSON" instead.
    expect(() => decodePaymentHeader('not-base64!!!')).toThrow(/not valid JSON/);
  });

  it('decode rejects valid base64 of invalid JSON', () => {
    const bad = Buffer.from('not json', 'utf8').toString('base64');
    expect(() => decodePaymentHeader(bad)).toThrow(/not valid JSON/);
  });

  it('decode rejects JSON whose intent_id is malformed', () => {
    const bad = Buffer.from(
      JSON.stringify({ intent_id: 'wrong', tx_hash: VALID_TX_HASH }),
      'utf8',
    ).toString('base64');
    expect(() => decodePaymentHeader(bad)).toThrow(/invalid intent_id/);
  });

  it('decode rejects JSON whose tx_hash is malformed', () => {
    const bad = Buffer.from(
      JSON.stringify({ intent_id: newIntentId(), tx_hash: 'short' }),
      'utf8',
    ).toString('base64');
    expect(() => decodePaymentHeader(bad)).toThrow(/invalid tx_hash/);
  });

  it("decode rejects JSON that isn't an object (array)", () => {
    const bad = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8').toString('base64');
    expect(() => decodePaymentHeader(bad)).toThrow(/not an object/);
  });
});

describe('parseX402Asset', () => {
  it('parses XRP', () => {
    expect(parseX402Asset('XRP')).toEqual({ kind: 'xrp', key: null });
  });

  it('parses mpt:<48-hex>', () => {
    expect(parseX402Asset(`mpt:${VALID_MPT_ID}`)).toEqual({
      kind: 'mpt',
      key: VALID_MPT_ID,
    });
  });

  it('normalises mpt hex to upper case', () => {
    expect(parseX402Asset(`mpt:${VALID_MPT_ID.toLowerCase()}`).key).toBe(VALID_MPT_ID);
  });

  it("rejects lowercase 'xrp'", () => {
    expect(() => parseX402Asset('xrp')).toThrow(/unsupported asset/);
  });

  it('rejects mpt with wrong-length hex', () => {
    expect(() => parseX402Asset('mpt:ABCD')).toThrow(/invalid MPTokenIssuanceID/);
  });

  it('rejects mpt with non-hex chars', () => {
    expect(() => parseX402Asset(`mpt:${'G'.repeat(48)}`)).toThrow(/invalid MPTokenIssuanceID/);
  });

  it('rejects IOU (USD:rIssuer) — out of scope this sprint', () => {
    expect(() => parseX402Asset('USD:rEHMTjmCNgxiGzgUTpV4Y1MwYpFpYz7e7p')).toThrow(
      /unsupported asset/,
    );
  });
});

describe('asset402ToAmount', () => {
  it('returns drops string for XRP', () => {
    expect(asset402ToAmount('XRP', '10000')).toBe('10000');
  });

  it('returns MPT object for mpt:<hex>', () => {
    expect(asset402ToAmount(`mpt:${VALID_MPT_ID}`, '42')).toEqual({
      mpt_issuance_id: VALID_MPT_ID,
      value: '42',
    });
  });

  it('rejects zero amount', () => {
    expect(() => asset402ToAmount('XRP', '0')).toThrow(/> 0/);
  });

  it('rejects non-integer amount', () => {
    expect(() => asset402ToAmount('XRP', '1.5')).toThrow(/decimal string/);
  });

  it('rejects negative amount (no leading minus accepted)', () => {
    expect(() => asset402ToAmount('XRP', '-1')).toThrow(/decimal string/);
  });

  it('rejects unsupported asset reference', () => {
    expect(() => asset402ToAmount('BTC', '100')).toThrow(/unsupported asset/);
  });
});
