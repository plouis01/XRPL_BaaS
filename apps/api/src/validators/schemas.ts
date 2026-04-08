import { z } from "zod";

// Zod schemas — single source of truth for request/response shapes.
// Each route imports its schemas from here. Keep them grouped by resource.

// ── Accounts ─────────────────────────────────────────────────────────────────
export const createAccountSchema = z.object({
  label: z.string().optional(),
  custody_mode: z.enum(["semi", "non_custodial"]).default("semi"),
  fund_amount: z.string().default("10"),
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

// ── Tokens, Credentials, Payments, etc. ──────────────────────────────────────
// TODO Sprint 2+: add schemas for each resource as routes are implemented.
