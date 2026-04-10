import type { HttpClient } from '../http.ts';
import type {
  ClawbackTokenParams,
  CreateTokenParams,
  FreezeTokenParams,
  QueuedTx,
  Token,
  TransferTokenParams,
} from '../types.ts';

export class Tokens {
  constructor(private http: HttpClient) {}

  /** Issue a new token (MPT by default, trustline opt-in). */
  async create(params: CreateTokenParams): Promise<Token> {
    return this.http.post<Token>('/v1/tokens', params);
  }

  /** Transfer tokens from issuer to a holder. */
  async transfer(tokenId: string, params: TransferTokenParams): Promise<QueuedTx> {
    return this.http.post<QueuedTx>(`/v1/tokens/${tokenId}/transfer`, params);
  }

  /** Freeze or unfreeze a token issuance. */
  async freeze(tokenId: string, params: FreezeTokenParams = {}): Promise<QueuedTx> {
    return this.http.put<QueuedTx>(`/v1/tokens/${tokenId}/freeze`, params);
  }

  /** Clawback tokens from a holder. */
  async clawback(tokenId: string, params: ClawbackTokenParams): Promise<QueuedTx> {
    return this.http.put<QueuedTx>(`/v1/tokens/${tokenId}/clawback`, params);
  }
}
