import type { HttpClient } from "../http.ts";
import type {
  Account,
  ConfigureSignersParams,
  CreateAccountParams,
  DeleteAccountParams,
  QueuedTx,
  RotateKeyParams,
} from "../types.ts";

export class Accounts {
  constructor(private http: HttpClient) {}

  /** Create a funded XRPL account. */
  async create(params: CreateAccountParams = {}): Promise<Account> {
    return this.http.post<Account>("/v1/accounts", params);
  }

  /** Get account info by XRPL address. */
  async get(address: string): Promise<Account> {
    return this.http.get<Account>(`/v1/accounts/${address}`);
  }

  /** Configure multi-sign signer list. */
  async configureSigners(
    address: string,
    params: ConfigureSignersParams,
  ): Promise<QueuedTx> {
    return this.http.put<QueuedTx>(`/v1/accounts/${address}/signers`, params);
  }

  /** Rotate the regular key for an account. */
  async rotateKey(
    address: string,
    params: RotateKeyParams = {},
  ): Promise<QueuedTx> {
    return this.http.post<QueuedTx>(
      `/v1/accounts/${address}/rotate-key`,
      params,
    );
  }

  /** Delete an XRPL account and reclaim reserves. */
  async delete(
    address: string,
    params: DeleteAccountParams,
  ): Promise<QueuedTx> {
    return this.http.delete<QueuedTx>(`/v1/accounts/${address}`, params);
  }
}
