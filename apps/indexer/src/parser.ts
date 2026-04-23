// Parses validated XRPL ledger + transaction payloads into normalized
// RailForge events. Pure — no I/O, no side effects. The store consumes
// these events and performs idempotent UPSERTs keyed by tx_hash.
//
// Two entry points:
//   - parseLedgerClose(event) → IndexedLedger (Sprint 3, high-water mark)
//   - parseTransaction(raw)  → IndexedTransaction | null (Sprint 4+)
//
// parseTransaction dispatches by `TransactionType` and returns a
// discriminated union the store can switch on. Unknown tx types return
// a generic `OtherTx` event so the dedup marker still gets written.

import type { LedgerCloseEvent } from './subscriber.ts';

// XRPL epoch offset: seconds between Unix epoch (1970-01-01) and
// XRPL epoch (2000-01-01). Used to convert XRPL close_time to ISO dates.
const XRPL_EPOCH_OFFSET = 946684800;

/**
 * Normalized ledger close record ready for persistence.
 */
export interface IndexedLedger {
  ledgerIndex: number;
  ledgerHash: string;
  /** ISO-8601 UTC string derived from the XRPL epoch close_time. */
  closedAt: string;
  txCount: number;
}

/**
 * Convert a raw LedgerCloseEvent (from the subscriber) into an
 * IndexedLedger (for the store). Pure function — no I/O, no side effects.
 *
 * Returns null if the event is somehow invalid (defensive — the subscriber
 * already filters, but belt-and-braces).
 */
export function parseLedgerClose(event: LedgerCloseEvent): IndexedLedger | null {
  if (!event.ledgerIndex || !event.ledgerHash) return null;

  const unixMs = (event.closeTime + XRPL_EPOCH_OFFSET) * 1000;
  const closedAt = new Date(unixMs).toISOString();

  return {
    ledgerIndex: event.ledgerIndex,
    ledgerHash: event.ledgerHash,
    closedAt,
    txCount: event.txCount,
  };
}

// ── Transaction-level events ───────────────────────────────────────────────

/**
 * Discriminator union of events emitted for a single validated tx.
 * The store dispatches on `kind` to the appropriate UPSERT path.
 *
 * `success` is derived from meta.TransactionResult === 'tesSUCCESS'.
 * Failed txs still land on-ledger (and still burn a fee) — we record
 * them so replay is idempotent and so "validated but failed" surfaces
 * correctly in reads.
 */
export interface TxEventBase {
  txHash: string;
  ledgerIndex: number;
  success: boolean;
}

/** XRPL currency shape as it appears in Payment Amount / Balance. */
export type XrplAmount =
  | string // XRP in drops
  | { currency: string; issuer: string; value: string }
  | { mpt_issuance_id: string; value: string };

export interface PaymentEvent extends TxEventBase {
  kind: 'payment';
  account: string;
  destination: string;
  amount: XrplAmount;
  destinationTag?: number;
}

export interface CredentialCreateEvent extends TxEventBase {
  kind: 'credential_create';
  issuer: string;
  subject: string;
  credentialType: string;
  expiration?: number;
}

export interface CredentialAcceptEvent extends TxEventBase {
  kind: 'credential_accept';
  account: string;
  issuer: string;
  credentialType: string;
}

export interface CredentialDeleteEvent extends TxEventBase {
  kind: 'credential_delete';
  account: string;
  issuer?: string;
  subject?: string;
  credentialType: string;
}

export interface OfferCreateEvent extends TxEventBase {
  kind: 'offer_create';
  account: string;
  sequence: number;
  takerPays: XrplAmount;
  takerGets: XrplAmount;
  domainId?: string;
}

export interface OfferCancelEvent extends TxEventBase {
  kind: 'offer_cancel';
  account: string;
  offerSequence: number;
}

export interface DomainSetEvent extends TxEventBase {
  kind: 'domain_set';
  account: string;
  /**
   * The on-ledger domain id. For updates this comes from the tx's DomainID
   * field; for creates it's extracted from meta.CreatedNode.LedgerIndex
   * (the PermissionedDomain ledger entry IS the hash). Either way the
   * store can match it against the API-side `domains.domain_id` column
   * to resolve the `pending-<uuid>` placeholder written on creation.
   */
  domainId?: string;
  acceptedCredentials?: Array<{ issuer: string; credentialType: string }>;
  /** True iff this tx CREATED a new PermissionedDomain ledger entry. */
  isCreate?: boolean;
}

export interface DomainDeleteEvent extends TxEventBase {
  kind: 'domain_delete';
  account: string;
  domainId: string;
}

/** Fallback for tx types we don't yet normalize — still dedup-tracked. */
export interface OtherTxEvent extends TxEventBase {
  kind: 'other';
  txType: string;
}

export type TxEvent =
  | PaymentEvent
  | CredentialCreateEvent
  | CredentialAcceptEvent
  | CredentialDeleteEvent
  | OfferCreateEvent
  | OfferCancelEvent
  | DomainSetEvent
  | DomainDeleteEvent
  | OtherTxEvent;

// ── Transaction parser ─────────────────────────────────────────────────────

/**
 * Shape of a validated tx from `ledger` command with `expand: true`.
 * xrpl.js typing is loose here — the field layout is either
 * `{ tx_blob?, meta?, metaData?, tx?, ...txFields }` or the tx fields
 * inlined at top-level with a sibling `metaData`. We normalize by
 * reading from whichever is present.
 */
interface RawValidatedTx {
  hash?: string;
  ledger_index?: number;
  TransactionType?: string;
  meta?: unknown;
  metaData?: unknown;
  tx?: Record<string, unknown>;
  [k: string]: unknown;
}

function metaResult(raw: RawValidatedTx): string | null {
  const m = (raw.meta ?? raw.metaData) as { TransactionResult?: string } | undefined;
  return typeof m?.TransactionResult === 'string' ? m.TransactionResult : null;
}

function pickTxFields(raw: RawValidatedTx): Record<string, unknown> {
  // rippled exposes tx fields in three different shapes depending on
  // api_version + command:
  //   - v2 response:      raw.tx_json (xrpl.js v4.6 default)
  //   - v1 `expand:true`: raw.tx
  //   - v1 inline:        fields live directly on raw
  // Prefer v2 → v1-nested → v1-inline.
  const r = raw as { tx_json?: unknown; tx?: unknown };
  if (r.tx_json && typeof r.tx_json === 'object') return r.tx_json as Record<string, unknown>;
  if (r.tx && typeof r.tx === 'object') return r.tx as Record<string, unknown>;
  return raw as Record<string, unknown>;
}

function amountFromField(v: unknown): XrplAmount | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof obj.currency === 'string' && typeof obj.issuer === 'string') {
      return {
        currency: obj.currency,
        issuer: obj.issuer,
        value: String(obj.value ?? '0'),
      };
    }
    if (typeof obj.mpt_issuance_id === 'string') {
      return {
        mpt_issuance_id: obj.mpt_issuance_id,
        value: String(obj.value ?? '0'),
      };
    }
  }
  return null;
}

/**
 * Parse a validated transaction payload into a normalized TxEvent.
 * Returns null when the payload is malformed or missing identifying
 * fields (hash / ledger_index / TransactionType). The caller should
 * treat null as "skip without dedup" — we never want to mark a tx
 * processed without knowing what it was.
 */
export function parseTransaction(raw: unknown): TxEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawValidatedTx;

  const txHash = typeof r.hash === 'string' ? r.hash : null;
  const ledgerIndex = typeof r.ledger_index === 'number' ? r.ledger_index : null;
  const fields = pickTxFields(r);
  const txType =
    typeof fields.TransactionType === 'string'
      ? fields.TransactionType
      : typeof r.TransactionType === 'string'
        ? r.TransactionType
        : null;

  if (!txHash || !ledgerIndex || !txType) return null;

  const success = metaResult(r) === 'tesSUCCESS';
  const base: TxEventBase = { txHash, ledgerIndex, success };

  switch (txType) {
    case 'Payment': {
      const account = String(fields.Account ?? '');
      const destination = String(fields.Destination ?? '');
      // API v2 renames the Payment submitted-amount field from Amount to
      // DeliverMax. Read both so the parser works across pool versions.
      const amount = amountFromField(fields.DeliverMax ?? fields.Amount);
      if (!account || !destination || !amount) return { kind: 'other', txType, ...base };
      const destinationTag =
        typeof fields.DestinationTag === 'number' ? fields.DestinationTag : undefined;
      return {
        kind: 'payment',
        account,
        destination,
        amount,
        destinationTag,
        ...base,
      };
    }
    case 'CredentialCreate': {
      const issuer = String(fields.Account ?? '');
      const subject = String(fields.Subject ?? '');
      const credentialType = String(fields.CredentialType ?? '');
      if (!issuer || !subject || !credentialType) return { kind: 'other', txType, ...base };
      const expiration = typeof fields.Expiration === 'number' ? fields.Expiration : undefined;
      return {
        kind: 'credential_create',
        issuer,
        subject,
        credentialType,
        expiration,
        ...base,
      };
    }
    case 'CredentialAccept': {
      const account = String(fields.Account ?? '');
      const issuer = String(fields.Issuer ?? '');
      const credentialType = String(fields.CredentialType ?? '');
      if (!account || !issuer || !credentialType) return { kind: 'other', txType, ...base };
      return {
        kind: 'credential_accept',
        account,
        issuer,
        credentialType,
        ...base,
      };
    }
    case 'CredentialDelete': {
      const account = String(fields.Account ?? '');
      const credentialType = String(fields.CredentialType ?? '');
      const issuer = typeof fields.Issuer === 'string' ? (fields.Issuer as string) : undefined;
      const subject = typeof fields.Subject === 'string' ? (fields.Subject as string) : undefined;
      if (!account || !credentialType) return { kind: 'other', txType, ...base };
      return {
        kind: 'credential_delete',
        account,
        issuer,
        subject,
        credentialType,
        ...base,
      };
    }
    case 'OfferCreate': {
      const account = String(fields.Account ?? '');
      const sequence = typeof fields.Sequence === 'number' ? fields.Sequence : null;
      const takerPays = amountFromField(fields.TakerPays);
      const takerGets = amountFromField(fields.TakerGets);
      if (!account || sequence === null || !takerPays || !takerGets)
        return { kind: 'other', txType, ...base };
      const domainId =
        typeof fields.DomainID === 'string' ? (fields.DomainID as string) : undefined;
      return {
        kind: 'offer_create',
        account,
        sequence,
        takerPays,
        takerGets,
        domainId,
        ...base,
      };
    }
    case 'OfferCancel': {
      const account = String(fields.Account ?? '');
      const offerSequence = typeof fields.OfferSequence === 'number' ? fields.OfferSequence : null;
      if (!account || offerSequence === null) return { kind: 'other', txType, ...base };
      return { kind: 'offer_cancel', account, offerSequence, ...base };
    }
    case 'PermissionedDomainSet': {
      const account = String(fields.Account ?? '');
      if (!account) return { kind: 'other', txType, ...base };
      // UPDATE form carries DomainID directly in tx fields. CREATE form
      // doesn't — the new entry's id is the LedgerIndex of the first
      // PermissionedDomain CreatedNode in meta.AffectedNodes.
      let domainId: string | undefined =
        typeof fields.DomainID === 'string' ? (fields.DomainID as string) : undefined;
      let isCreate = false;
      if (!domainId) {
        const meta = (r.meta ?? r.metaData) as { AffectedNodes?: unknown[] } | undefined;
        const nodes = Array.isArray(meta?.AffectedNodes) ? meta.AffectedNodes : [];
        for (const node of nodes) {
          const created = (
            node as {
              CreatedNode?: { LedgerEntryType?: string; LedgerIndex?: string };
            }
          ).CreatedNode;
          if (
            created?.LedgerEntryType === 'PermissionedDomain' &&
            typeof created.LedgerIndex === 'string'
          ) {
            domainId = created.LedgerIndex;
            isCreate = true;
            break;
          }
        }
      }
      const rawAccepted = fields.AcceptedCredentials;
      const acceptedCredentials = Array.isArray(rawAccepted)
        ? rawAccepted
            .map((entry) => {
              const e = (
                entry as {
                  Credential?: { Issuer?: string; CredentialType?: string };
                }
              )?.Credential;
              if (!e || typeof e.Issuer !== 'string' || typeof e.CredentialType !== 'string') {
                return null;
              }
              return { issuer: e.Issuer, credentialType: e.CredentialType };
            })
            .filter((x): x is { issuer: string; credentialType: string } => x !== null)
        : undefined;
      return {
        kind: 'domain_set',
        account,
        domainId,
        acceptedCredentials,
        isCreate,
        ...base,
      };
    }
    case 'PermissionedDomainDelete': {
      const account = String(fields.Account ?? '');
      const domainId = typeof fields.DomainID === 'string' ? (fields.DomainID as string) : '';
      if (!account || !domainId) return { kind: 'other', txType, ...base };
      return { kind: 'domain_delete', account, domainId, ...base };
    }
    default:
      return { kind: 'other', txType, ...base };
  }
}
