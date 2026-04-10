import type { HttpClient } from '../http.ts';
import type {
  AuditEntry,
  Delegation,
  DelegationWithTx,
  GrantPermissionParams,
  QueuedTx,
  RequestOptions,
  RevokePermissionParams,
} from '../types.ts';

export class Permissions {
  constructor(private http: HttpClient) {}

  /** Grant permissions to a delegate. */
  async grant(params: GrantPermissionParams, opts?: RequestOptions): Promise<DelegationWithTx> {
    return this.http.post<DelegationWithTx>('/v1/permissions', params, opts?.idempotencyKey);
  }

  /** List all active delegates for a delegator. */
  async list(delegatorAddress: string): Promise<{ data: Delegation[] }> {
    return this.http.get<{ data: Delegation[] }>(`/v1/permissions/${delegatorAddress}`);
  }

  /** Revoke a delegation. */
  async revoke(
    delegatorAddress: string,
    delegateAddress: string,
    params: RevokePermissionParams,
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.delete<QueuedTx>(
      `/v1/permissions/${delegatorAddress}/${delegateAddress}`,
      params,
      opts?.idempotencyKey,
    );
  }

  /** Get audit log for a delegator. */
  async audit(delegatorAddress: string): Promise<{ data: AuditEntry[] }> {
    return this.http.get<{ data: AuditEntry[] }>(`/v1/permissions/audit/${delegatorAddress}`);
  }
}
