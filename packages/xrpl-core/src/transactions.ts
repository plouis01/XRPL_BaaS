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
  MPTokenIssuanceCreate,
  Payment,
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
