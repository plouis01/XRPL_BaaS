// Pure helpers for the x402 HTTP-402 payment layer.
//
// SPRINT_10_PLAN.md §2 + §4.1. All functions in this module are pure / no
// I/O — they're imported on both API (intent creation, verification) and
// SDK (payer side) hot paths.
//
// Intent IDs use the format `x402_intent_<26-base32>` where the base32
// payload encodes 16 random bytes (~128 bits of entropy). DestinationTags
// are derived deterministically from the intent ID via CRC32, modded into
// the lower 0..0xFFEFFFFF range — the upper 0xFFF00000..0xFFFFFFFF band is
// reserved for free-retry / refund tags so a replayed Payment can't
// silently satisfy a different intent.

import { randomBytes } from 'node:crypto';
import type { Amount, MPTAmount } from 'xrpl/dist/npm/models/common';

// `Amount` in xrpl.js common is `string | IssuedCurrencyAmount` and does
// NOT include MPTAmount, even though Payment.Amount accepts it. So the
// x402 helpers return a wider union — the call site assigns to
// Payment.Amount which accepts both shapes.
export type X402PaymentAmount = Amount | MPTAmount;

// ── Constants ────────────────────────────────────────────────────────────────

const INTENT_ID_PREFIX = 'x402_intent_';
const INTENT_ID_BODY_LEN = 26;
// 16 random bytes = 128 bits → 26 base32 chars (last char has 2 unused bits).
const INTENT_ID_ENTROPY_BYTES = 16;
// Reserved tag band — see file header.
export const X402_DESTINATION_TAG_MOD = 0xfff0_0000;
// Crockford-style base32 alphabet (no I/L/O/U to avoid visual ambiguity).
// Order matters: index → character. The decoder isn't shipped because
// intent IDs round-trip as opaque strings; we only ever generate them.
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ── CRC32 (IEEE 802.3 polynomial 0xEDB88320) ─────────────────────────────────
// Table is built lazily — it's 1 KB of state but unused if nothing in the
// process ever derives a destination tag (e.g. payer-side SDK in some flows).

let CRC32_TABLE: Uint32Array | null = null;

const buildCrc32Table = (): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
};

const crc32 = (input: string): number => {
  if (CRC32_TABLE === null) {
    CRC32_TABLE = buildCrc32Table();
  }
  const table = CRC32_TABLE;
  let crc = 0xffff_ffff;
  for (let i = 0; i < input.length; i++) {
    const byte = input.charCodeAt(i) & 0xff;
    // biome-ignore lint/style/noNonNullAssertion: table is fully initialized
    crc = (table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
};

// ── Intent IDs ───────────────────────────────────────────────────────────────

/**
 * Generate a new x402 intent ID of the shape `x402_intent_<26-base32>`.
 *
 * The base32 payload encodes 16 cryptographically random bytes. The
 * intent ID is the verifier's primary key and the input to the
 * destination-tag CRC, so collision resistance must come from this
 * function — never derive an intent ID from user input.
 */
export const newIntentId = (): string => {
  const bytes = randomBytes(INTENT_ID_ENTROPY_BYTES);
  let bits = 0;
  let bitCount = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is in range
    bits = (bits << 8) | bytes[i]!;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      const idx = (bits >>> bitCount) & 0x1f;
      // biome-ignore lint/style/noNonNullAssertion: idx ∈ [0, 31]
      out += BASE32_ALPHABET[idx]!;
    }
  }
  if (bitCount > 0) {
    const idx = (bits << (5 - bitCount)) & 0x1f;
    // biome-ignore lint/style/noNonNullAssertion: idx ∈ [0, 31]
    out += BASE32_ALPHABET[idx]!;
  }
  return INTENT_ID_PREFIX + out.slice(0, INTENT_ID_BODY_LEN);
};

/**
 * Cheap structural validator for intent IDs received from the wire.
 * The verifier still consults the DB — this only rejects obviously
 * malformed inputs before they hit the hot path.
 */
export const isValidIntentId = (id: unknown): id is string => {
  if (typeof id !== 'string') return false;
  if (!id.startsWith(INTENT_ID_PREFIX)) return false;
  const body = id.slice(INTENT_ID_PREFIX.length);
  if (body.length !== INTENT_ID_BODY_LEN) return false;
  for (let i = 0; i < body.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is in range
    if (!BASE32_ALPHABET.includes(body[i]!)) return false;
  }
  return true;
};

// ── DestinationTag derivation ────────────────────────────────────────────────

/**
 * Derive the deterministic uint32 DestinationTag the payer must include on
 * their settling Payment transaction. CRC32 modded into [0, 0xFFEFFFFF];
 * the upper 0xFFF00000..0xFFFFFFFF band is reserved for retry / refund
 * flows in future sprints.
 *
 * The verifier rejects any tx whose DestinationTag does not match this
 * function's output for the intent ID it claims to satisfy
 * (SPRINT_10_PLAN.md §6 step 5).
 */
export const intentIdToDestinationTag = (intentId: string): number => {
  if (!isValidIntentId(intentId)) {
    throw new Error(`x402: malformed intentId ${JSON.stringify(intentId)}`);
  }
  return crc32(intentId) % X402_DESTINATION_TAG_MOD;
};

// ── X-PAYMENT header encode / decode ────────────────────────────────────────

const TX_HASH_RE = /^[0-9A-Fa-f]{64}$/;

export interface PaymentHeaderPayload {
  intentId: string;
  txHash: string;
}

/**
 * Encode the `X-PAYMENT` header value the payer sends on retry.
 * Wire format: `base64(utf8(JSON.stringify({ intent_id, tx_hash })))`.
 * Snake-cased keys to match the rest of the protocol body shape.
 */
export const encodePaymentHeader = (intentId: string, txHash: string): string => {
  if (!isValidIntentId(intentId)) {
    throw new Error('x402: encodePaymentHeader: invalid intentId');
  }
  if (!TX_HASH_RE.test(txHash)) {
    throw new Error('x402: encodePaymentHeader: invalid txHash (need 64 hex)');
  }
  const json = JSON.stringify({ intent_id: intentId, tx_hash: txHash });
  return Buffer.from(json, 'utf8').toString('base64');
};

/**
 * Decode an `X-PAYMENT` header value into its components. Fails closed on
 * any malformation — caller may treat any thrown error as "missing/invalid
 * payment header" and reissue the 402.
 */
export const decodePaymentHeader = (header: string): PaymentHeaderPayload => {
  if (typeof header !== 'string' || header.length === 0) {
    throw new Error('x402: decodePaymentHeader: empty header');
  }
  let json: string;
  try {
    json = Buffer.from(header, 'base64').toString('utf8');
  } catch {
    throw new Error('x402: decodePaymentHeader: not valid base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('x402: decodePaymentHeader: not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('x402: decodePaymentHeader: payload not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const intentId = obj.intent_id;
  const txHash = obj.tx_hash;
  if (!isValidIntentId(intentId)) {
    throw new Error('x402: decodePaymentHeader: invalid intent_id');
  }
  if (typeof txHash !== 'string' || !TX_HASH_RE.test(txHash)) {
    throw new Error('x402: decodePaymentHeader: invalid tx_hash');
  }
  return { intentId, txHash };
};

// ── Asset reference → xrpl.js Amount ────────────────────────────────────────

const MPT_PREFIX = 'mpt:';
// MPTokenIssuanceID is a 192-bit (24-byte) identifier → 48 hex chars.
const MPT_ID_RE = /^[0-9A-Fa-f]{48}$/;
// XRP drops are unbounded positive integers in string form.
const DECIMAL_INT_RE = /^[0-9]+$/;

export type X402AssetKind = 'xrp' | 'mpt';

export interface ParsedX402Asset {
  kind: X402AssetKind;
  /** MPTokenIssuanceID hex for `mpt`; null for `xrp`. */
  key: string | null;
}

/**
 * Parse an x402 asset reference (`XRP` or `mpt:<48-hex>`) into the
 * (kind, key) tuple used by both the DB schema and the verifier.
 * IOU / trust-line forms are explicitly rejected this sprint.
 */
export const parseX402Asset = (asset: string): ParsedX402Asset => {
  if (typeof asset !== 'string') {
    throw new Error('x402: parseX402Asset: not a string');
  }
  if (asset === 'XRP') {
    return { kind: 'xrp', key: null };
  }
  if (asset.startsWith(MPT_PREFIX)) {
    const hex = asset.slice(MPT_PREFIX.length);
    if (!MPT_ID_RE.test(hex)) {
      throw new Error('x402: parseX402Asset: invalid MPTokenIssuanceID');
    }
    // Normalize to upper case to match xrpl.js's canonical hex emission.
    return { kind: 'mpt', key: hex.toUpperCase() };
  }
  throw new Error(
    `x402: parseX402Asset: unsupported asset ${JSON.stringify(asset)} (XRP and mpt:<hex> only)`,
  );
};

/**
 * Build an xrpl.js Payment `Amount` from the canonical x402 (asset, amount)
 * pair. Used by the SDK payer flow when constructing the settling tx.
 *
 * - XRP → drops as a decimal string
 * - MPT → `{ mpt_issuance_id, value }`
 *
 * Amounts are validated as positive integer strings. xrpl.js's own
 * validation runs at signing time too, but rejecting here gives a much
 * clearer error than a downstream "invalid Amount" deep in the lib.
 */
export const asset402ToAmount = (asset: string, amount: string): X402PaymentAmount => {
  if (typeof amount !== 'string' || !DECIMAL_INT_RE.test(amount)) {
    throw new Error('x402: asset402ToAmount: amount must be a decimal string');
  }
  if (amount === '0') {
    throw new Error('x402: asset402ToAmount: amount must be > 0');
  }
  const parsed = parseX402Asset(asset);
  if (parsed.kind === 'xrp') {
    return amount;
  }
  // biome-ignore lint/style/noNonNullAssertion: kind='mpt' guarantees key set
  return { mpt_issuance_id: parsed.key!, value: amount };
};
