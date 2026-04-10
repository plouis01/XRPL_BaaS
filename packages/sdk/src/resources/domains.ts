import type { HttpClient } from '../http.ts';
import type {
  CheckDomainMembershipParams,
  CreateDomainParams,
  Domain,
  DomainMembersList,
  DomainMembershipResult,
  DomainWithTx,
  QueuedTx,
  RequestOptions,
  UpdateDomainParams,
} from '../types.ts';

export class Domains {
  constructor(private http: HttpClient) {}

  /** Create a new permissioned domain. */
  async create(params: CreateDomainParams, opts?: RequestOptions): Promise<DomainWithTx> {
    return this.http.post<DomainWithTx>('/v1/domains', params, opts?.idempotencyKey);
  }

  /** Get domain details by ID. */
  async get(domainId: string): Promise<Domain> {
    return this.http.get<Domain>(`/v1/domains/${domainId}`);
  }

  /** Update accepted credentials on a domain. */
  async update(
    domainId: string,
    params: UpdateDomainParams,
    opts?: RequestOptions,
  ): Promise<DomainWithTx> {
    return this.http.put<DomainWithTx>(`/v1/domains/${domainId}`, params, opts?.idempotencyKey);
  }

  /** Delete a domain. */
  async delete(domainId: string, opts?: RequestOptions): Promise<QueuedTx> {
    return this.http.delete<QueuedTx>(`/v1/domains/${domainId}`, undefined, opts?.idempotencyKey);
  }

  /** List all members qualifying for a domain. */
  async listMembers(domainId: string): Promise<DomainMembersList> {
    return this.http.get<DomainMembersList>(`/v1/domains/${domainId}/members`);
  }

  /** Check if an account qualifies for a domain. */
  async checkMembership(
    domainId: string,
    params: CheckDomainMembershipParams,
  ): Promise<DomainMembershipResult> {
    return this.http.post<DomainMembershipResult>(`/v1/domains/${domainId}/check`, params);
  }
}
