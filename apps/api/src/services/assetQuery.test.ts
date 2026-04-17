// Unit tests for parseAssetParam / rippledAssetSpec. Pure string
// parsing — no XRPL client. Verifies the three asset shapes used by
// the orderbook / amm / balances routes.

import { describe, expect, it } from 'vitest';
import { AssetParseError, parseAssetParam, rippledAssetSpec } from './assetQuery.ts';

const ISSUER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

describe('parseAssetParam', () => {
  it('parses "XRP" case-insensitively', () => {
    expect(parseAssetParam('XRP')).toEqual({ kind: 'xrp' });
    expect(parseAssetParam('xrp')).toEqual({ kind: 'xrp' });
  });

  it('parses IOU currency:issuer', () => {
    expect(parseAssetParam(`USD:${ISSUER}`)).toEqual({
      kind: 'iou',
      currency: 'USD',
      issuer: ISSUER,
    });
  });

  it('parses mpt:<hex-id>', () => {
    expect(parseAssetParam('mpt:DEADBEEF')).toEqual({
      kind: 'mpt',
      mptIssuanceId: 'DEADBEEF',
    });
  });

  it('throws on missing colon / non-XRP no-issuer input', () => {
    expect(() => parseAssetParam('USDonly')).toThrow(AssetParseError);
  });

  it('throws on non-hex MPT id', () => {
    expect(() => parseAssetParam('mpt:not-hex!')).toThrow(AssetParseError);
  });

  it('throws when currency or issuer is empty', () => {
    expect(() => parseAssetParam(':issuer')).toThrow(AssetParseError);
    expect(() => parseAssetParam('USD:')).toThrow(AssetParseError);
  });

  it('decodes URL-encoded input', () => {
    expect(parseAssetParam(encodeURIComponent(`USD:${ISSUER}`))).toEqual({
      kind: 'iou',
      currency: 'USD',
      issuer: ISSUER,
    });
  });
});

describe('rippledAssetSpec', () => {
  it('XRP → { currency: "XRP" }', () => {
    expect(rippledAssetSpec({ kind: 'xrp' })).toEqual({ currency: 'XRP' });
  });

  it('IOU → { currency, issuer }', () => {
    expect(rippledAssetSpec({ kind: 'iou', currency: 'USD', issuer: ISSUER })).toEqual({
      currency: 'USD',
      issuer: ISSUER,
    });
  });

  it('MPT → { mpt_issuance_id }', () => {
    expect(rippledAssetSpec({ kind: 'mpt', mptIssuanceId: 'ABC123' })).toEqual({
      mpt_issuance_id: 'ABC123',
    });
  });
});
