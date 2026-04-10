import type { HttpClient } from '../http.ts';
import type {
  ClawbackTokenParams,
  CreateTokenParams,
  FreezeTokenParams,
  QueuedTx,
  RequestOptions,
  Token,
  TransferTokenParams,
} from '../types.ts';

export class Tokens {
  constructor(private http: HttpClient) {}

  /** Issue a new token (MPT by default, trustline opt-in). */
  async create(params: CreateTokenParams, opts?: RequestOptions): Promise<Token> {
    return this.http.post<Token>('/v1/tokens', params, opts?.idempotencyKey);
  }

  /** Transfer tokens from issuer to a holder. */
  async transfer(
    tokenId: string,
    params: TransferTokenParams,
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.post<QueuedTx>(`/v1/tokens/${tokenId}/transfer`, params, opts?.idempotencyKey);
  }

  /** Freeze or unfreeze a token issuance. */
  async freeze(
    tokenId: string,
    params: FreezeTokenParams = {},
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.put<QueuedTx>(`/v1/tokens/${tokenId}/freeze`, params, opts?.idempotencyKey);
  }

  /** Clawback tokens from a holder. */
  async clawback(
    tokenId: string,
    params: ClawbackTokenParams,
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.put<QueuedTx>(`/v1/tokens/${tokenId}/clawback`, params, opts?.idempotencyKey);
  }
}
