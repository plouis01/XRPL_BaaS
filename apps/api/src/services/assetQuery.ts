// Shared helpers for read-only asset queries (orderbook, AMM, balances).
//
// Route params use the compact `base`/`counter`/`asset1`/`asset2` format:
//   - 'XRP'                → XRP
//   - 'USD:rIssuer...'     → issued currency
//   - 'mpt:<issuance_id>'  → MPT
//
// rippled's book_offers / amm_info expect a different shape:
//   { currency: 'XRP' } for XRP,
//   { currency, issuer } for IOU,
//   { mpt_issuance_id } for MPT (XLS-33).

export interface ParsedAsset {
  kind: 'xrp' | 'iou' | 'mpt';
  currency?: string;
  issuer?: string;
  mptIssuanceId?: string;
}

export class AssetParseError extends Error {
  constructor(
    public readonly param: string,
    reason: string,
  ) {
    super(`invalid asset "${param}": ${reason}`);
    this.name = 'AssetParseError';
  }
}

/**
 * Parse a URL-encoded asset parameter. Accepts:
 *   - 'XRP'             (case-insensitive)
 *   - 'USD:rIssuer...'  (IOU — any 3-40 char currency code)
 *   - 'mpt:<id>'        (MPT issuance ID, hex)
 */
export function parseAssetParam(raw: string): ParsedAsset {
  const decoded = decodeURIComponent(raw);
  if (decoded.toUpperCase() === 'XRP') return { kind: 'xrp' };
  if (decoded.toLowerCase().startsWith('mpt:')) {
    const id = decoded.slice(4);
    if (!/^[0-9a-fA-F]+$/.test(id)) {
      throw new AssetParseError(raw, 'mpt issuance id must be hex');
    }
    return { kind: 'mpt', mptIssuanceId: id };
  }
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) {
    throw new AssetParseError(raw, 'expected "XRP", "CUR:issuer", or "mpt:<id>"');
  }
  const currency = decoded.slice(0, colonIdx);
  const issuer = decoded.slice(colonIdx + 1);
  if (!currency || !issuer) {
    throw new AssetParseError(raw, 'currency and issuer must both be non-empty');
  }
  return { kind: 'iou', currency, issuer };
}

/**
 * Convert a ParsedAsset into the shape rippled expects for book_offers /
 * amm_info request fields.
 */
export function rippledAssetSpec(a: ParsedAsset): Record<string, string> {
  if (a.kind === 'xrp') return { currency: 'XRP' };
  if (a.kind === 'mpt') return { mpt_issuance_id: a.mptIssuanceId as string };
  return { currency: a.currency as string, issuer: a.issuer as string };
}
