import type { HttpClient } from '../http.ts';
import type {
  Agent,
  AgentAllowlistEntry,
  ProvisionAgentParams,
  ProvisionedAgent,
  RequestOptions,
  RevokeAgentResult,
} from '../types.ts';

/**
 * Agent launcher — VISION.md "agent launcher" (POST /v1/agents).
 *
 * An agent is a delegate keypair that holds bounded signing authority on a
 * managed parent account, scoped to an allowlist (destinations, tokens,
 * optionally XLS-80 domains) and an XRP spend policy. The delegate seed is
 * returned EXACTLY ONCE in `provision()`'s response — persist it immediately;
 * subsequent reads omit it.
 */
export class Agents {
  constructor(private http: HttpClient) {}

  /**
   * Provision a new agent. Generates the delegate keypair, queues the
   * SignerListSet that grants on-ledger authority, installs the spend
   * policy, and writes the allowlist atomically.
   *
   * The returned `agent_seed` is the only copy the SDK ever sees — store it
   * before the promise resolves out of scope. `status` will be `'pending'`
   * until the grant tx validates; poll `get(id)` for the flip to `'active'`.
   */
  async provision(params: ProvisionAgentParams, opts?: RequestOptions): Promise<ProvisionedAgent> {
    return this.http.post<ProvisionedAgent>('/v1/agents', params, opts?.idempotencyKey);
  }

  /** List all agents owned by the authenticated client. */
  async list(): Promise<{ data: Agent[] }> {
    return this.http.get<{ data: Agent[] }>('/v1/agents');
  }

  /** Fetch a single agent. Use this to poll the `pending → active` transition. */
  async get(agentId: string): Promise<Agent> {
    return this.http.get<Agent>(`/v1/agents/${agentId}`);
  }

  /**
   * Replace the allowlist on a live agent. Pure DB op — no on-ledger work,
   * since the underlying signer-list grant doesn't reference individual
   * destinations or tokens. Body shape mirrors the provision-time `allowlist`
   * field; the agent's preset (immutable post-provision) dictates which
   * `entry_type` values are valid.
   *
   * Replace semantics: pass the FULL new list. To add an entry, fetch via
   * `get(id)`, append, then call this. To remove, fetch, filter, then call.
   *
   * Status gate: only `'active'` agents accept updates. `'pending'` /
   * `'revoking'` / `'revoked'` / `'failed'` return 409.
   */
  async updateAllowlist(agentId: string, allowlist: AgentAllowlistEntry[]): Promise<Agent> {
    return this.http.put<Agent>(`/v1/agents/${agentId}/allowlist`, {
      allowlist,
    });
  }

  /**
   * Stage revocation. Queues a SignerListSet that strips the delegate;
   * the agent transitions to `'revoking'` immediately and to `'revoked'`
   * once the tx validates (or back to `'active'` on tx failure).
   */
  async revoke(agentId: string, opts?: RequestOptions): Promise<RevokeAgentResult> {
    return this.http.delete<RevokeAgentResult>(
      `/v1/agents/${agentId}`,
      undefined,
      opts?.idempotencyKey,
    );
  }
}
