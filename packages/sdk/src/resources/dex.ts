import type { HttpClient } from '../http.ts';
import type {
  AmmDepositParams,
  AmmWithdrawParams,
  CancelOfferParams,
  CreateOfferParams,
  QueuedTx,
  RequestOptions,
} from '../types.ts';

export class Dex {
  constructor(private http: HttpClient) {}

  /** Create a DEX offer. */
  async createOffer(params: CreateOfferParams, opts?: RequestOptions): Promise<QueuedTx> {
    return this.http.post<QueuedTx>('/v1/dex/offers', params, opts?.idempotencyKey);
  }

  /** Cancel an existing DEX offer. */
  async cancelOffer(
    offerId: string,
    params: CancelOfferParams,
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.delete<QueuedTx>(`/v1/dex/offers/${offerId}`, params, opts?.idempotencyKey);
  }

  /** Deposit liquidity into an AMM pool. */
  async ammDeposit(params: AmmDepositParams, opts?: RequestOptions): Promise<QueuedTx> {
    return this.http.post<QueuedTx>('/v1/dex/amm/deposit', params, opts?.idempotencyKey);
  }

  /** Withdraw liquidity from an AMM pool. */
  async ammWithdraw(params: AmmWithdrawParams, opts?: RequestOptions): Promise<QueuedTx> {
    return this.http.post<QueuedTx>('/v1/dex/amm/withdraw', params, opts?.idempotencyKey);
  }
}
