import { z } from 'zod';

// Zod schemas — single source of truth for request/response shapes.
// Each route imports its schemas from here. Keep them grouped by resource.

// ── Accounts ─────────────────────────────────────────────────────────────────
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
});

// ── Credentials, Payments, etc. ──────────────────────────────────────────────
// TODO later sprints: add schemas for each resource as routes are implemented.
