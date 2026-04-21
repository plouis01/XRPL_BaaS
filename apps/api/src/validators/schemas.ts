import { z } from 'zod';

// Zod schemas — single source of truth for request/response shapes.
// Each route imports its schemas from here. Keep them grouped by resource.

// ── Accounts ─────────────────────────────────────────────────────────────────

// Re-used XRPL r-address shape (24-34 base58 chars after 'r').
const xrplAddressSchema = z
  .string()
  .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, 'invalid XRPL address');

export const createAccountSchema = z.object({
  label: z.string().optional(),
  custody_mode: z.enum(['semi', 'non_custodial']).default('semi'),
  fund_amount: z.string().default('10'),
  multisign: z
    .object({
      quorum: z.number().int().min(1),
      signers: z
        .array(
          z.object({
            address: z.string(),
            weight: z.number().int().min(1),
          }),
        )
        .min(1)
        .max(32),
    })
    .optional(),
});

// PUT /v1/accounts/:address/signers — multi-sign list configuration.
// quorum=0 + empty signers is the documented "delete signer list" path
// (matches buildSignerListSet's behavior).
export const configureSignersSchema = z.object({
  quorum: z.number().int().min(0),
  signers: z
    .array(
      z.object({
        address: xrplAddressSchema,
        weight: z.number().int().min(1).max(65535),
      }),
    )
    .max(32),
});

// POST /v1/accounts/:address/rotate-key — install or remove a regular key.
// `regular_key: null` clears the existing key (the SetRegularKey w/o
// RegularKey field). Omitting the field is the same as null — defensive
// against clients that don't serialize null cleanly.
export const rotateRegularKeySchema = z.object({
  regular_key: xrplAddressSchema.nullable().optional(),
});

// DELETE /v1/accounts/:address — body carries the destination for the
// reclaimed reserve. The destination MUST be a funded account.
export const deleteAccountSchema = z.object({
  destination: xrplAddressSchema,
  destination_tag: z.number().int().min(0).optional(),
});

// ── Tokens ───────────────────────────────────────────────────────────────────
export const createTokenSchema = z.object({
  /** Managed issuer account address. Must belong to the authenticated client. */
  issuer: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, 'invalid XRPL address'),
  /**
   * Token model. Defaults to MPT per CLAUDE.md ("MPT is the default token
   * model, trust lines are opt-in"). Callers must pass 'trustline'
   * explicitly to get the legacy issued-currency flow.
   */
  type: z.enum(['mpt', 'trustline']).default('mpt'),
  /**
   * Currency code. For MPTs this is free-form metadata (persisted in the
   * tokens table). For trustlines it's the standard 3-char ISO code or
   * 40-char hex for extended codes.
   */
  currency_code: z.string().min(1).max(40),
  /** Transfer fee in basis points. 0-50000 (0%-50%). */
  transfer_fee: z.number().int().min(0).max(50_000).default(0),
  /** Enable clawback. Default true per CLAUDE.md compliance posture. */
  clawback: z.boolean().default(true),
  /** Enable freeze. Default true per CLAUDE.md compliance posture. */
  freeze_enabled: z.boolean().default(true),
  /** Max supply as a decimal string. Optional — unbounded if omitted. */
  max_supply: z.string().optional(),
  /** Optional metadata (key/value JSON). Merged into tokens.metadata. */
  metadata: z.record(z.unknown()).optional(),
  /**
   * Trust line opt-in only: the limit a trust line will hold. Required when
   * type='trustline'. The Zod refine below enforces this so we never reach
   * the service with a half-configured trust line request.
   */
  trustline_limit: z.string().optional(),
});

// POST /v1/tokens/:id/transfer — value is decimal string for both MPT
// and trustline tokens. The service uses tokens.tokenType to pick the
// right builder (buildMptPayment vs buildIssuedCurrencyPayment).
export const transferTokenSchema = z.object({
  destination: xrplAddressSchema,
  amount: z.string().min(1),
  destination_tag: z.number().int().min(0).optional(),
});

// PUT /v1/tokens/:id/freeze — locks the entire issuance, or just one
// holder if `holder` is supplied. Set `unfreeze: true` to clear the lock.
export const freezeTokenSchema = z.object({
  holder: xrplAddressSchema.optional(),
  unfreeze: z.boolean().default(false),
});

// PUT /v1/tokens/:id/clawback — must specify which holder to claw from
// and how much. Both MPT and issued-currency tokens use this same shape;
// the service picks the right builder based on tokenType.
export const clawbackTokenSchema = z.object({
  holder: xrplAddressSchema,
  amount: z.string().min(1),
});

// ── Webhooks ─────────────────────────────────────────────────────────────────
//
// The supported event types are intentionally a closed set. Adding a new
// event means adding it here AND adding a fan-out site for it (currently
// only `transaction.validated` is wired, in apps/worker/src/jobs/txConfirmer).
// Letting clients subscribe to events that nothing emits is just confusing.
export const WEBHOOK_EVENT_TYPES = [
  'transaction.validated',
  'transaction.failed',
  'credential.issued',
  'credential.accepted',
  'credential.revoked',
  'credential.expiring',
  'domain.created',
  'domain.updated',
  'domain.deleted',
] as const;

export const createWebhookEndpointSchema = z.object({
  url: z.string().url('webhook url must be a valid URL'),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1, 'subscribe to at least one event'),
});

// ── Payments ────────────────────────────────────────────────────────────────
//
// The send-payment schema is polymorphic: the client supplies one of three
// amount shapes (XRP drops, MPT, or issued currency). We validate them
// into a discriminated union so the service can pick the right builder.

export const sendPaymentSchema = z
  .object({
    /** Source XRPL account. Must belong to the authenticated client. */
    source: xrplAddressSchema,
    destination: xrplAddressSchema,
    destination_tag: z.number().int().min(0).optional(),
    memo: z.string().optional(),

    // ── Amount shape: exactly one of these three groups ──

    /** XRP payment: amount in drops as a string. */
    amount_drops: z.string().optional(),

    /** MPT payment. */
    mpt_issuance_id: z.string().optional(),
    /** MPT or issued-currency value as a decimal string. */
    value: z.string().optional(),

    /** Issued-currency payment. */
    currency: z.string().optional(),
    issuer: xrplAddressSchema.optional(),
  })
  .refine(
    (d) => {
      // Exactly one of: XRP (amount_drops), MPT (mpt_issuance_id+value), or
      // issued currency (currency+issuer+value).
      const hasXrp = !!d.amount_drops;
      const hasMpt = !!d.mpt_issuance_id && !!d.value;
      const hasIssued = !!d.currency && !!d.issuer && !!d.value;
      return [hasXrp, hasMpt, hasIssued].filter(Boolean).length === 1;
    },
    {
      message:
        'Provide exactly one of: amount_drops (XRP), mpt_issuance_id+value (MPT), or currency+issuer+value (issued currency)',
    },
  );

// Batch payments — sequential fallback while XLS-56 V1.1 is pending.
// Supported modes are the subset that genuinely works without atomic
// on-chain batching: UNTIL_FAILURE (default) and INDEPENDENT. The two
// atomic modes (ALL_OR_NOTHING, ONLY_ONE) cannot be faithfully emulated
// pre-amendment, so the service rejects them with a 501 + clear message.
export const BATCH_PAYMENT_MODES = ['UNTIL_FAILURE', 'INDEPENDENT'] as const;

export const batchPaymentsSchema = z.object({
  /** Mode: UNTIL_FAILURE stops enqueueing on first item error; INDEPENDENT enqueues all. */
  mode: z.enum(BATCH_PAYMENT_MODES).default('UNTIL_FAILURE'),
  /** 2–20 payments per batch. Each item has the same shape as POST /v1/payments. */
  payments: z.array(sendPaymentSchema).min(2).max(20),
});

export const createEscrowSchema = z
  .object({
    source: xrplAddressSchema,
    destination: xrplAddressSchema,
    /** Amount in drops (XRP only — escrow doesn't support tokens yet on mainnet). */
    amount_drops: z.string().min(1),
    /** XRPL epoch seconds. At least one of finish_after / cancel_after is required. */
    finish_after: z.number().int().optional(),
    cancel_after: z.number().int().optional(),
    /** PREIMAGE-SHA-256 crypto-condition (hex). */
    condition: z.string().optional(),
    destination_tag: z.number().int().min(0).optional(),
  })
  .refine((d) => d.finish_after !== undefined || d.cancel_after !== undefined, {
    message: 'At least one of finish_after or cancel_after is required',
  });

export const finishEscrowSchema = z.object({
  /** The account finishing the escrow (pays the tx fee). */
  source: xrplAddressSchema,
  /** The account that created the escrow. */
  owner: xrplAddressSchema,
  /** The Sequence number of the EscrowCreate tx. */
  offer_sequence: z.number().int().min(0),
  condition: z.string().optional(),
  fulfillment: z.string().optional(),
});

export const cancelEscrowSchema = z.object({
  source: xrplAddressSchema,
  owner: xrplAddressSchema,
  offer_sequence: z.number().int().min(0),
});

// ── Credentials (XLS-70) ────────────────────────────────────────────────────
//
// Hex-encoded credential type: 1-128 hex chars (up to 64 bytes).
const hexCredentialTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9a-fA-F]+$/, 'credential_type must be hex-encoded');

export const issueCredentialSchema = z.object({
  /** The managed account that will issue the credential (Account field). */
  issuer_address: xrplAddressSchema,
  /** The account receiving the credential. */
  subject_address: xrplAddressSchema,
  /** Hex-encoded credential type (up to 64 bytes). */
  credential_type: hexCredentialTypeSchema,
  /** XRPL epoch expiration. Optional. */
  expiration: z.number().int().min(0).optional(),
  /** Hex-encoded URI (optional metadata pointer). */
  uri: z
    .string()
    .regex(/^[0-9a-fA-F]*$/, 'uri must be hex-encoded')
    .optional(),
  /** Optional metadata (key/value JSON). */
  metadata: z.record(z.unknown()).optional(),
});

export const acceptCredentialSchema = z.object({
  /** The managed subject account accepting the credential. */
  subject_address: xrplAddressSchema,
});

export const verifyCredentialSchema = z.object({
  subject_address: xrplAddressSchema,
  issuer_address: xrplAddressSchema,
  credential_type: hexCredentialTypeSchema,
});

// ── Domains (XLS-80) ───────────────────────────────────────────────────────

const acceptedCredentialEntrySchema = z.object({
  issuer: xrplAddressSchema,
  credential_type: hexCredentialTypeSchema,
});

export const createDomainSchema = z.object({
  /** The managed account that owns the domain. */
  owner_address: xrplAddressSchema,
  /** 1-10 accepted credential entries. */
  accepted_credentials: z.array(acceptedCredentialEntrySchema).min(1).max(10),
});

export const updateDomainSchema = z.object({
  /** Updated accepted credential entries (replaces the existing list). */
  accepted_credentials: z.array(acceptedCredentialEntrySchema).min(1).max(10),
});

export const checkDomainMembershipSchema = z.object({
  /** The account to check membership for. */
  subject_address: xrplAddressSchema,
});

// ── Permissions (XLS-75 fallback: multi-sign roles) ─────────────────────

/** XLS-75 permission values. Pre-V1.1 the service uses multi-sign roles. */
export const PERMISSION_VALUES = [
  'Payment',
  'TrustSet',
  'OfferCreate',
  'OfferCancel',
  'AccountSet',
  'EscrowCreate',
  'EscrowFinish',
  'EscrowCancel',
  'CredentialCreate',
  'CredentialAccept',
  'CredentialDelete',
] as const;

export const grantPermissionSchema = z.object({
  /** The delegator account (must be managed). */
  delegator_address: xrplAddressSchema,
  /** The delegate account receiving permissions. */
  delegate_address: xrplAddressSchema,
  /** List of permission strings (e.g. 'Payment', 'TrustSet'). */
  permissions: z.array(z.enum(PERMISSION_VALUES)).min(1).max(10),
  /** Signer weight for the delegate on the signer list. Default 1. */
  weight: z.number().int().min(1).max(65535).default(1),
  /**
   * Signer-list quorum. REVIEW.md MED-05: optional; defaults to 1 at the
   * service layer (preserves the pre-fix "any single delegate signs" default
   * for single-delegate setups). A tenant building 2-of-N coordination must
   * set this explicitly. Upper bound is XRPL's signer-list max weight sum.
   */
  quorum: z.number().int().min(1).max(65535).optional(),
});

export const revokePermissionSchema = z.object({
  /** Required to confirm the delegator account. */
  delegator_address: xrplAddressSchema,
});

// ── DEX ─────────────────────────────────────────────────────────────────

/**
 * Asset amount: one of XRP drops, issued currency (currency+issuer+value),
 * or MPT (mpt_issuance_id+value).
 */
const assetAmountSchema = z
  .object({
    drops: z.string().optional(),
    currency: z.string().optional(),
    issuer: xrplAddressSchema.optional(),
    value: z.string().optional(),
    mpt_issuance_id: z.string().optional(),
  })
  .refine(
    (d) => {
      const hasXrp = !!d.drops;
      const hasIssued = !!d.currency && !!d.issuer && !!d.value;
      const hasMpt = !!d.mpt_issuance_id && !!d.value;
      return [hasXrp, hasIssued, hasMpt].filter(Boolean).length === 1;
    },
    {
      message:
        'Provide exactly one of: drops (XRP), currency+issuer+value (issued), or mpt_issuance_id+value (MPT)',
    },
  );

/** Asset identifier (no value): for pool pair identification in AMM ops. */
const assetCurrencySchema = z
  .object({
    drops: z.literal(true).optional(),
    currency: z.string().optional(),
    issuer: xrplAddressSchema.optional(),
    mpt_issuance_id: z.string().optional(),
  })
  .refine(
    (d) => {
      const isXrp = !!d.drops;
      const isIssued = !!d.currency && !!d.issuer;
      const isMpt = !!d.mpt_issuance_id;
      return [isXrp, isIssued, isMpt].filter(Boolean).length === 1;
    },
    {
      message: 'Provide exactly one of: drops (XRP), currency+issuer, or mpt_issuance_id',
    },
  );

export const createOfferSchema = z.object({
  /** Account placing the offer (must be managed). */
  account: xrplAddressSchema,
  taker_gets: assetAmountSchema,
  taker_pays: assetAmountSchema,
  expiration: z.number().int().min(0).optional(),
  /** Replace an existing offer by its sequence number. */
  offer_sequence: z.number().int().min(0).optional(),
  /** OfferCreate flags (tfPassive=65536, tfImmediateOrCancel=131072, tfFillOrKill=262144, tfSell=524288). */
  flags: z
    .number()
    .int()
    .min(0)
    .refine((v) => (v & ~(65536 | 131072 | 262144 | 524288)) === 0, {
      message:
        'flags must be a combination of tfPassive(65536), tfImmediateOrCancel(131072), tfFillOrKill(262144), tfSell(524288)',
    })
    .optional(),
  /** Permissioned DEX domain ID (XLS-81). */
  domain_id: z.string().optional(),
});

export const cancelOfferSchema = z.object({
  /** Account that owns the offer. */
  account: xrplAddressSchema,
  /** Sequence number of the offer to cancel. */
  offer_sequence: z.number().int().min(0),
});

export const ammDepositSchema = z.object({
  account: xrplAddressSchema,
  asset: assetCurrencySchema,
  asset2: assetCurrencySchema,
  amount: assetAmountSchema.optional(),
  amount2: assetAmountSchema.optional(),
  e_price: assetAmountSchema.optional(),
  lp_token_out: z
    .object({ currency: z.string(), issuer: z.string(), value: z.string() })
    .optional(),
  flags: z.number().int().min(0).optional(),
});

export const ammWithdrawSchema = z.object({
  account: xrplAddressSchema,
  asset: assetCurrencySchema,
  asset2: assetCurrencySchema,
  amount: assetAmountSchema.optional(),
  amount2: assetAmountSchema.optional(),
  e_price: assetAmountSchema.optional(),
  lp_token_in: z.object({ currency: z.string(), issuer: z.string(), value: z.string() }).optional(),
  flags: z.number().int().min(0).optional(),
});
