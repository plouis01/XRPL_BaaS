// Canonical XRPL transaction builders.
//
// CRITICAL: all transaction construction lives in THIS file.
// api, worker, and indexer import from here. Inline tx construction in
// route handlers, service files, or worker jobs is a bug.
//
// Each builder returns a partially-populated xrpl.js Transaction object.
// The caller (usually the txSubmitter pipeline) fills in:
//   - Sequence       (via TxSequencer)
//   - LastLedgerSequence (via ledger_current + LAST_LEDGER_OFFSET)
//   - Fee            (via server_info or DEFAULT_FEE_DROPS fallback)
//   - SigningPubKey + TxnSignature (via Signer.sign)
//
// Builders intentionally do NOT auto-fill these fields. That keeps the
// submission pipeline as the single chokepoint for fee/sequence/signing
// decisions, and makes each builder trivially unit-testable.

import type {
  AccountDelete,
  AccountSet,
  Clawback,
  EscrowCancel,
  EscrowCreate,
  EscrowFinish,
  MPTokenIssuanceCreate,
  MPTokenIssuanceSet,
  Payment,
  SetRegularKey,
  SignerEntry,
  SignerListSet,
  TrustSet,
} from 'xrpl';

// ── Payment (XRP or issued currency) ────────────────────────────────────────

export interface BuildXrpPaymentInput {
  account: string;
  destination: string;
  /** Amount in drops (1 XRP = 1_000_000 drops). */
  amountDrops: string;
  /** Optional destination tag (for exchanges and custodial wallets). */
  destinationTag?: number;
  /** Optional memo — UTF-8 string, encoded to hex before submission. */
  memo?: string;
}

export function buildXrpPayment(input: BuildXrpPaymentInput): Payment {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: input.account,
    Destination: input.destination,
    Amount: input.amountDrops,
  };
  if (input.destinationTag !== undefined) {
    tx.DestinationTag = input.destinationTag;
  }
  if (input.memo !== undefined) {
    tx.Memos = [
      {
        Memo: {
          MemoData: Buffer.from(input.memo, 'utf8').toString('hex').toUpperCase(),
        },
      },
    ];
  }
  return tx;
}

export interface BuildIssuedCurrencyPaymentInput {
  account: string;
  destination: string;
  currency: string;
  issuer: string;
  value: string;
  destinationTag?: number;
}

/**
 * Issued-currency Payment (trust-line-based). For MPT payments, see
 * buildMptPayment. The issuer is the same as the token's creator.
 */
export function buildIssuedCurrencyPayment(input: BuildIssuedCurrencyPaymentInput): Payment {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: input.account,
    Destination: input.destination,
    Amount: {
      currency: input.currency,
      issuer: input.issuer,
      value: input.value,
    },
  };
  if (input.destinationTag !== undefined) {
    tx.DestinationTag = input.destinationTag;
  }
  return tx;
}

// ── Account configuration ───────────────────────────────────────────────────

export interface BuildAccountSetInput {
  account: string;
  /** Set one of the AsfXxx flags (e.g. AccountSetAsfFlags.asfRequireAuth). */
  setFlag?: number;
  /** Clear one of the AsfXxx flags. */
  clearFlag?: number;
  /** Hash of the account domain (e.g. sha256("example.com"), hex-encoded). */
  domain?: string;
  /** Transfer fee in billionths (0 = no fee, max 2_000_000_000 = 100%). */
  transferRate?: number;
  /** xrp-ledger.toml hash. */
  walletLocator?: string;
}

export function buildAccountSet(input: BuildAccountSetInput): AccountSet {
  const tx: AccountSet = {
    TransactionType: 'AccountSet',
    Account: input.account,
  };
  if (input.setFlag !== undefined) tx.SetFlag = input.setFlag;
  if (input.clearFlag !== undefined) tx.ClearFlag = input.clearFlag;
  if (input.domain !== undefined) tx.Domain = input.domain.toUpperCase();
  if (input.transferRate !== undefined) tx.TransferRate = input.transferRate;
  if (input.walletLocator !== undefined) tx.WalletLocator = input.walletLocator.toUpperCase();
  return tx;
}

// ── Multi-sign configuration ────────────────────────────────────────────────

export interface BuildSignerListSetInput {
  account: string;
  /** Required signer weight sum. Pass 0 to delete the signer list entirely. */
  signerQuorum: number;
  /** Max 32 entries per XRPL rules. */
  signerEntries: Array<{ address: string; weight: number }>;
}

export function buildSignerListSet(input: BuildSignerListSetInput): SignerListSet {
  if (input.signerEntries.length > 32) {
    throw new Error(`SignerListSet supports at most 32 entries, got ${input.signerEntries.length}`);
  }
  if (input.signerQuorum < 0) {
    throw new Error(`SignerQuorum must be >= 0, got ${input.signerQuorum}`);
  }

  const entries: SignerEntry[] = input.signerEntries.map((e) => ({
    SignerEntry: {
      Account: e.address,
      SignerWeight: e.weight,
    },
  }));

  // SignerQuorum = 0 + empty entries = delete the signer list.
  // Any other combination sets/updates it.
  const tx: SignerListSet = {
    TransactionType: 'SignerListSet',
    Account: input.account,
    SignerQuorum: input.signerQuorum,
    SignerEntries: entries,
  };
  return tx;
}

// ── Account deletion ────────────────────────────────────────────────────────

export interface BuildAccountDeleteInput {
  account: string;
  /** Where to send the reclaimed XRP reserve. Must be a funded account. */
  destination: string;
  destinationTag?: number;
}

export function buildAccountDelete(input: BuildAccountDeleteInput): AccountDelete {
  const tx: AccountDelete = {
    TransactionType: 'AccountDelete',
    Account: input.account,
    Destination: input.destination,
  };
  if (input.destinationTag !== undefined) {
    tx.DestinationTag = input.destinationTag;
  }
  return tx;
}

// ── MPT issuance (XLS-33) ───────────────────────────────────────────────────

export interface BuildMptIssuanceCreateInput {
  account: string;
  /** Human-readable asset scale (decimals). 0-19. */
  assetScale?: number;
  /** Transfer fee in basis points, 0-50000 (0%-50%). */
  transferFee?: number;
  /** Max amount in smallest units as string (MPT uses arbitrary precision). */
  maximumAmount?: string;
  /** Per-MPT flags (tfMPTCanLock, tfMPTRequireAuth, tfMPTCanEscrow, etc.) */
  flags?: number;
  /** Optional metadata (up to 1024 bytes, hex-encoded). */
  mptMetadata?: string;
}

export function buildMptIssuanceCreate(input: BuildMptIssuanceCreateInput): MPTokenIssuanceCreate {
  if (input.transferFee !== undefined && (input.transferFee < 0 || input.transferFee > 50_000)) {
    throw new Error(`MPT transferFee must be 0-50000 basis points, got ${input.transferFee}`);
  }
  if (input.assetScale !== undefined && (input.assetScale < 0 || input.assetScale > 19)) {
    throw new Error(`MPT assetScale must be 0-19, got ${input.assetScale}`);
  }

  const tx: MPTokenIssuanceCreate = {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: input.account,
  };
  if (input.assetScale !== undefined) tx.AssetScale = input.assetScale;
  if (input.transferFee !== undefined) tx.TransferFee = input.transferFee;
  if (input.maximumAmount !== undefined) tx.MaximumAmount = input.maximumAmount;
  if (input.flags !== undefined) tx.Flags = input.flags;
  if (input.mptMetadata !== undefined) tx.MPTokenMetadata = input.mptMetadata.toUpperCase();
  return tx;
}

// ── Trust line (legacy issued currency opt-in) ──────────────────────────────

export interface BuildTrustSetInput {
  account: string;
  currency: string;
  issuer: string;
  /** Max the account is willing to hold. */
  limit: string;
  /** Optional QualityIn/QualityOut for transfer-rate adjustments. */
  qualityIn?: number;
  qualityOut?: number;
}

export function buildTrustSet(input: BuildTrustSetInput): TrustSet {
  const tx: TrustSet = {
    TransactionType: 'TrustSet',
    Account: input.account,
    LimitAmount: {
      currency: input.currency,
      issuer: input.issuer,
      value: input.limit,
    },
  };
  if (input.qualityIn !== undefined) tx.QualityIn = input.qualityIn;
  if (input.qualityOut !== undefined) tx.QualityOut = input.qualityOut;
  return tx;
}

// ── MPT payment (XLS-33 token transfer) ─────────────────────────────────────
//
// Payment.Amount is `string | IssuedCurrencyAmount | MPTAmount` per xrpl.js's
// type union. The MPT shape is `{ mpt_issuance_id, value }` — same value
// space as IssuedCurrencyAmount, just keyed by the issuance id rather than
// (currency, issuer).

export interface BuildMptPaymentInput {
  account: string;
  destination: string;
  /** The MPT issuance id (hex). Returned by the issuance create's metadata. */
  mptIssuanceId: string;
  /** Amount in the smallest unit of the MPT, as a decimal string. */
  value: string;
  destinationTag?: number;
}

export function buildMptPayment(input: BuildMptPaymentInput): Payment {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: input.account,
    Destination: input.destination,
    Amount: {
      mpt_issuance_id: input.mptIssuanceId,
      value: input.value,
    },
  };
  if (input.destinationTag !== undefined) {
    tx.DestinationTag = input.destinationTag;
  }
  return tx;
}

// ── MPT freeze / unfreeze (XLS-33) ──────────────────────────────────────────
//
// MPTokenIssuanceSet has two flag values for freezing:
//   tfMPTLock   = 0x00000001  → freeze
//   tfMPTUnlock = 0x00000002  → unfreeze
//
// Optional Holder address: if set, ONLY that holder is locked/unlocked.
// If omitted, the entire issuance is locked (issuer-wide freeze).

export const MPT_LOCK_FLAG = 0x00000001;
export const MPT_UNLOCK_FLAG = 0x00000002;

export interface BuildMptIssuanceSetInput {
  account: string;
  /** The MPT issuance id (hex). */
  mptIssuanceId: string;
  /** 'lock' to freeze, 'unlock' to unfreeze. */
  action: 'lock' | 'unlock';
  /** Optional holder — when set, freeze only this holder, not the whole issuance. */
  holder?: string;
}

export function buildMptIssuanceSet(input: BuildMptIssuanceSetInput): MPTokenIssuanceSet {
  const tx: MPTokenIssuanceSet = {
    TransactionType: 'MPTokenIssuanceSet',
    Account: input.account,
    MPTokenIssuanceID: input.mptIssuanceId,
    Flags: input.action === 'lock' ? MPT_LOCK_FLAG : MPT_UNLOCK_FLAG,
  };
  if (input.holder !== undefined) {
    tx.Holder = input.holder;
  }
  return tx;
}

// ── Clawback (issued currency + MPT) ────────────────────────────────────────
//
// Two amount shapes are accepted by xrpl.js's Clawback:
//   { currency, issuer, value }       — issued currency
//   { mpt_issuance_id, value }        — MPT
//
// We expose two builder helpers (one per shape) so callers can't accidentally
// mix the two field sets. Both produce the same Transaction type — the
// difference is purely in how the Amount field is shaped.

export interface BuildIssuedCurrencyClawbackInput {
  /** The issuer reclaiming the funds. */
  account: string;
  /** Currency code (3-char ISO or 40-char hex). */
  currency: string;
  /** The holder address whose funds are being clawed back. */
  holder: string;
  /** Decimal string. */
  value: string;
}

export function buildIssuedCurrencyClawback(input: BuildIssuedCurrencyClawbackInput): Clawback {
  const tx: Clawback = {
    TransactionType: 'Clawback',
    Account: input.account,
    // Per the XRPL Clawback spec: the Amount.issuer field carries the
    // HOLDER address being clawed back, NOT the issuer of the currency
    // (the issuer is implicit — it's the Account submitting the tx).
    // This is counter-intuitive but matches the protocol.
    Amount: {
      currency: input.currency,
      issuer: input.holder,
      value: input.value,
    },
  };
  return tx;
}

export interface BuildMptClawbackInput {
  /** The issuer reclaiming the funds. */
  account: string;
  /** The MPT issuance id (hex). */
  mptIssuanceId: string;
  /** The holder address whose funds are being clawed back. */
  holder: string;
  /** Decimal string. */
  value: string;
}

export function buildMptClawback(input: BuildMptClawbackInput): Clawback {
  const tx: Clawback = {
    TransactionType: 'Clawback',
    Account: input.account,
    Amount: {
      mpt_issuance_id: input.mptIssuanceId,
      value: input.value,
    },
    // For MPT clawback the Holder field on the tx itself carries the
    // address (not on the Amount, unlike the issued-currency case).
    Holder: input.holder,
  };
  return tx;
}

// ── SetRegularKey (regular key rotation) ────────────────────────────────────
//
// RegularKey is optional: omit it (or pass null) to remove the regular
// key entirely. Setting a new value installs/replaces it. We model the
// "remove" case explicitly via `null` instead of `undefined` so callers
// can't get it wrong by forgetting to pass the field.

export interface BuildSetRegularKeyInput {
  account: string;
  /** New regular key address, or null to clear. */
  regularKey: string | null;
}

export function buildSetRegularKey(input: BuildSetRegularKeyInput): SetRegularKey {
  const tx: SetRegularKey = {
    TransactionType: 'SetRegularKey',
    Account: input.account,
  };
  if (input.regularKey !== null) {
    tx.RegularKey = input.regularKey;
  }
  return tx;
}

// ── Escrow ──────────────────────────────────────────────────────────────────
//
// EscrowCreate locks XRP (or MPT, per xrpl.js types) until either:
//   (a) FinishAfter time passes AND the optional Condition is fulfilled, or
//   (b) CancelAfter time passes and the escrow is cancelled.
// At least one of FinishAfter / CancelAfter MUST be set (rippled rejects
// the tx otherwise). We validate this in the builder rather than letting
// rippled produce a cryptic temMALFORMED.
//
// Times are XRPL epoch seconds (seconds since 2000-01-01T00:00:00Z).
// The constant below converts from Unix epoch to XRPL epoch.
export const XRPL_EPOCH_OFFSET = 946684800;

export interface BuildEscrowCreateInput {
  account: string;
  destination: string;
  /** Amount in drops (XRP). */
  amountDrops: string;
  /** XRPL epoch timestamp after which the escrow can be finished. */
  finishAfter?: number;
  /** XRPL epoch timestamp after which the escrow can be cancelled. */
  cancelAfter?: number;
  /** PREIMAGE-SHA-256 crypto-condition (hex). */
  condition?: string;
  destinationTag?: number;
}

export function buildEscrowCreate(input: BuildEscrowCreateInput): EscrowCreate {
  if (input.finishAfter === undefined && input.cancelAfter === undefined) {
    throw new Error('EscrowCreate requires at least one of finishAfter or cancelAfter');
  }
  if (
    input.cancelAfter !== undefined &&
    input.finishAfter !== undefined &&
    input.cancelAfter <= input.finishAfter
  ) {
    throw new Error('cancelAfter must be after finishAfter');
  }

  const tx: EscrowCreate = {
    TransactionType: 'EscrowCreate',
    Account: input.account,
    Destination: input.destination,
    Amount: input.amountDrops,
  };
  if (input.finishAfter !== undefined) tx.FinishAfter = input.finishAfter;
  if (input.cancelAfter !== undefined) tx.CancelAfter = input.cancelAfter;
  if (input.condition !== undefined) tx.Condition = input.condition;
  if (input.destinationTag !== undefined) tx.DestinationTag = input.destinationTag;
  return tx;
}

export interface BuildEscrowFinishInput {
  account: string;
  /** The account that created the escrow. */
  owner: string;
  /** The Sequence number of the EscrowCreate tx. */
  offerSequence: number;
  /** The crypto-condition from the EscrowCreate (hex). Required if the escrow has a Condition. */
  condition?: string;
  /** The fulfillment that satisfies the condition (hex). */
  fulfillment?: string;
}

export function buildEscrowFinish(input: BuildEscrowFinishInput): EscrowFinish {
  const tx: EscrowFinish = {
    TransactionType: 'EscrowFinish',
    Account: input.account,
    Owner: input.owner,
    OfferSequence: input.offerSequence,
  };
  if (input.condition !== undefined) tx.Condition = input.condition;
  if (input.fulfillment !== undefined) tx.Fulfillment = input.fulfillment;
  return tx;
}

export interface BuildEscrowCancelInput {
  account: string;
  /** The account that created the escrow. */
  owner: string;
  /** The Sequence number of the EscrowCreate tx. */
  offerSequence: number;
}

export function buildEscrowCancel(input: BuildEscrowCancelInput): EscrowCancel {
  return {
    TransactionType: 'EscrowCancel',
    Account: input.account,
    Owner: input.owner,
    OfferSequence: input.offerSequence,
  };
}
