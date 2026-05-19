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
  /**
   * REVIEW B1 opt-out: when set true by a route handler, the idempotency
   * middleware will keep the lock + 409 semantics on duplicate requests
   * but will SKIP writing the response body to Redis. Used by routes
   * whose response carries credentials that must not sit in the cache
   * (e.g. POST /v1/agents returns the delegate seed exactly once — a
   * 24 h Redis copy would defeat that contract). Replays of the same
   * idempotency key after the original response will run the handler
   * fresh; if a handler is replay-unsafe in that mode it must also
   * write idempotently to its own storage (the DB constraint on
   * `transactions.idempotency_key` already does this for tx-emitting
   * routes, and POST /v1/agents fits that pattern via the underlying
   * SignerListSet insert).
   */
  skipIdempotencyCache?: boolean;
  /**
   * SPRINT_10_PLAN.md §4.4. Set by the x402 middleware after a payment
   * verifies successfully — the route handler may read `intent.id` /
   * `intent.consumingTxHash` to emit them in its response (e.g. an
   * `X-PAYMENT-RESPONSE` header). The opaque `unknown` typing here keeps
   * `types.ts` free of a circular import from x402Intent.service; the
   * route reads it via `c.get('x402Intent') as X402Intent`.
   */
  x402Intent?: unknown;
};

export type AppEnv = {
  Variables: AppVariables;
};
