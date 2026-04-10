import type { HttpClient } from '../http.ts';
import type {
  AcceptCredentialParams,
  Credential,
  CredentialIssuer,
  CredentialWithTx,
  IssueCredentialParams,
  QueuedTx,
  RequestOptions,
  VerifyCredentialParams,
  VerifyCredentialResult,
} from '../types.ts';

export class Credentials {
  constructor(private http: HttpClient) {}

  /** Issue a new credential (CredentialCreate tx). */
  async issue(params: IssueCredentialParams, opts?: RequestOptions): Promise<CredentialWithTx> {
    return this.http.post<CredentialWithTx>('/v1/credentials', params, opts?.idempotencyKey);
  }

  /** Get credential details by ID. */
  async get(credentialId: string): Promise<Credential> {
    return this.http.get<Credential>(`/v1/credentials/${credentialId}`);
  }

  /** Accept a pending credential (CredentialAccept tx). */
  async accept(
    credentialId: string,
    params: AcceptCredentialParams,
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.post<QueuedTx>(
      `/v1/credentials/${credentialId}/accept`,
      params,
      opts?.idempotencyKey,
    );
  }

  /** Revoke/delete a credential (CredentialDelete tx). */
  async revoke(credentialId: string, opts?: RequestOptions): Promise<QueuedTx> {
    return this.http.delete<QueuedTx>(
      `/v1/credentials/${credentialId}`,
      undefined,
      opts?.idempotencyKey,
    );
  }

  /** Verify if an account holds a valid credential. */
  async verify(params: VerifyCredentialParams): Promise<VerifyCredentialResult> {
    return this.http.post<VerifyCredentialResult>('/v1/credentials/verify', params);
  }

  /** List marketplace credential issuers. */
  async listIssuers(): Promise<{ issuers: CredentialIssuer[] }> {
    return this.http.get<{ issuers: CredentialIssuer[] }>('/v1/credentials/issuers');
  }
}
