import type { HttpClient } from '../http.ts';
import type {
  Account,
  ConfigureSignersParams,
  CreateAccountParams,
  DeleteAccountParams,
  QueuedTx,
  RequestOptions,
  RotateKeyParams,
} from '../types.ts';

export class Accounts {
  constructor(private http: HttpClient) {}

  /** Create a funded XRPL account. */
  async create(params: CreateAccountParams = {}, opts?: RequestOptions): Promise<Account> {
    return this.http.post<Account>('/v1/accounts', params, opts?.idempotencyKey);
  }

  /** Get account info by XRPL address. */
  async get(address: string): Promise<Account> {
    return this.http.get<Account>(`/v1/accounts/${address}`);
  }

  /** Configure multi-sign signer list. */
  async configureSigners(
    address: string,
    params: ConfigureSignersParams,
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.put<QueuedTx>(`/v1/accounts/${address}/signers`, params, opts?.idempotencyKey);
  }

  /** Rotate the regular key for an account. */
  async rotateKey(
    address: string,
    params: RotateKeyParams = {},
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.post<QueuedTx>(
      `/v1/accounts/${address}/rotate-key`,
      params,
      opts?.idempotencyKey,
    );
  }

  /** Delete an XRPL account and reclaim reserves. */
  async delete(
    address: string,
    params: DeleteAccountParams,
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.delete<QueuedTx>(`/v1/accounts/${address}`, params, opts?.idempotencyKey);
  }
}
