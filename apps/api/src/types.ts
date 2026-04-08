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
};

export type AppEnv = {
  Variables: AppVariables;
};
