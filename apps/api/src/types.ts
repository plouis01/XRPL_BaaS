// Hono context type augmentation. Middleware writes to `c.set`, handlers read
// via `c.get` — these types make those reads type-safe.

export type AppVariables = {
  /** Set by auth middleware after successful API key lookup. */
  clientId: string;
  /** Set by auth middleware — used by rate limiter and audit logging. */
  apiKeyId: string;
  /** Per-key request budget (requests per minute). Set by auth middleware. */
  rateLimit: number;
  /** 'testnet' | 'mainnet' — drives which XRPL pool the request hits. */
  environment: 'testnet' | 'mainnet';
  /**
   * VISION.md agent launcher: when the auth'd API key is bound to an
   * agent (api_keys.agent_id IS NOT NULL), this carries the agent UUID
   * so service-layer code can gate against agent_allowlists + agents.status.
   * NULL / absent for regular client-scoped keys.
   */
  agentId?: string | null;
};

export type AppEnv = {
  Variables: AppVariables;
};
