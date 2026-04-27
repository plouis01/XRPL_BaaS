// Agent presets — static scaffolding templates for POST /v1/agents.
//
// Each preset names the XRPL permissions the delegate is granted, the
// spend policy installed on the agent, and which allowlist entry types
// are required / optional in the request body. The service layer composes
// account.service, permission.service, spendPolicy.service, and (optionally)
// domain.service using these values.
//
// Presets are code-defined, not DB rows. Rationale:
//   - Adding a preset is a code change that ships through CI + review
//   - Field shapes evolve with XRPL amendments (XLS-75 V1.1, XLS-81) and
//     should be type-checked against validators/schemas.ts
//   - Tenants can't arbitrarily compose permission sets (security posture
//     of the launcher is that RailForge picks the shape, not the client)
//
// When XLS-75 V1.1 activates, permissions below map 1:1 to DelegateSet
// permission strings. Until then, permission.service installs them as a
// role-restricted signer list entry (documented fallback in
// ARCHITECTURE.md §4.4 / PLAN.md §7).
//
// Explicitly NOT shipped in v1:
//   - `defi-agent` — Multisubs-on-Base covers DeFi composability; shipping
//     a weak-on-XRPL equivalent here would confuse positioning
//   - Presets that grant `AccountSet` / `SignerListSet` / `SetRegularKey` —
//     those mutate the parent account's auth surface, which the agent
//     should never touch (enforced at validator level, see PERMISSION_VALUES
//     in validators/schemas.ts)

import type { PERMISSION_VALUES } from '../validators/schemas.ts';

export type AgentPermission = (typeof PERMISSION_VALUES)[number];

export type AgentAllowlistEntryType = 'destination' | 'token' | 'domain';

export interface AgentPresetSpendPolicy {
  /** XRP per-tx cap in drops. Null = no cap. */
  maxXrpPerTxDrops: string | null;
  /** XRP daily rolling cap in drops. Null = no cap. */
  dailyXrpLimitDrops: string | null;
}

export interface AgentPreset {
  name: string;
  description: string;
  /** Permissions granted to the delegate (agent) keypair. */
  permissions: readonly AgentPermission[];
  /** Default spend policy installed at provisioning. Caller can override. */
  defaultSpendPolicy: AgentPresetSpendPolicy;
  /** Allowlist entry types the preset expects. Others are rejected at validator level. */
  allowedEntryTypes: readonly AgentAllowlistEntryType[];
  /**
   * If true, the request MUST include at least one allowlist entry. Payment
   * agents without any destination allowlist are accidentally-unconstrained
   * and rejected. Treasury agents may start empty and have entries added via
   * PUT /v1/agents/:id/allowlist.
   */
  requireAllowlist: boolean;
}

// ── Preset: payment-agent ────────────────────────────────────────────────────
// A narrow-purpose agent that moves XRP and tokens to an allowlisted set of
// destinations. Conservative defaults: 10 XRP per tx, 100 XRP per day.
// Supports MPT / IOU payments via the `token` allowlist type.
const PAYMENT_AGENT: AgentPreset = {
  name: 'payment-agent',
  description:
    'Pay allowlisted destinations up to a daily XRP cap. Supports XRP, MPT, and issued-currency payments.',
  permissions: ['Payment'] as const,
  defaultSpendPolicy: {
    // 10 XRP
    maxXrpPerTxDrops: '10000000',
    // 100 XRP
    dailyXrpLimitDrops: '100000000',
  },
  allowedEntryTypes: ['destination', 'token'] as const,
  requireAllowlist: true,
};

// ── Preset: treasury-agent ───────────────────────────────────────────────────
// Internal-disbursement agent with larger caps: 1000 XRP per tx, 10000 XRP
// per day. Allowlist can include XLS-80 domains so the agent may only pay
// accounts that hold a qualifying credential (KYC'd holder set, loyalty
// members, etc). Allowlist may start empty because treasury flows often
// populate it dynamically.
const TREASURY_AGENT: AgentPreset = {
  name: 'treasury-agent',
  description:
    'Disburse XRP and tokens to destinations or XLS-80 domain members with higher per-tx and daily caps.',
  permissions: ['Payment'] as const,
  defaultSpendPolicy: {
    // 1000 XRP
    maxXrpPerTxDrops: '1000000000',
    // 10000 XRP
    dailyXrpLimitDrops: '10000000000',
  },
  allowedEntryTypes: ['destination', 'token', 'domain'] as const,
  requireAllowlist: false,
};

// Single source of truth for the preset name list. The Zod schema in
// validators/schemas.ts imports this directly (`z.enum(AGENT_PRESET_NAMES)`),
// so the validator and the runtime registry can never drift. Adding a new
// preset is a 2-step change in this file: append the literal here, then
// add the matching `AGENT_PRESETS` entry — TS won't compile until both
// are done.
export const AGENT_PRESET_NAMES = ['payment-agent', 'treasury-agent'] as const;

export type AgentPresetName = (typeof AGENT_PRESET_NAMES)[number];

export const AGENT_PRESETS: Record<AgentPresetName, AgentPreset> = {
  'payment-agent': PAYMENT_AGENT,
  'treasury-agent': TREASURY_AGENT,
};

export function getPreset(name: string): AgentPreset | null {
  if (!Object.hasOwn(AGENT_PRESETS, name)) return null;
  return AGENT_PRESETS[name as AgentPresetName];
}
