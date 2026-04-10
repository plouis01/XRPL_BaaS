import type { HttpClient } from '../http.ts';
import type {
  CancelEscrowParams,
  CreateEscrowParams,
  FinishEscrowParams,
  Payment,
  QueuedTx,
  RequestOptions,
  SendPaymentParams,
} from '../types.ts';

export class Payments {
  constructor(private http: HttpClient) {}

  /** Send an XRP, MPT, or issued-currency payment. */
  async send(params: SendPaymentParams, opts?: RequestOptions): Promise<QueuedTx> {
    return this.http.post<QueuedTx>('/v1/payments', params, opts?.idempotencyKey);
  }

  /** Get payment status by transaction ID. */
  async get(paymentId: string): Promise<Payment> {
    return this.http.get<Payment>(`/v1/payments/${paymentId}`);
  }

  /** Create a time- or condition-based escrow. */
  async createEscrow(params: CreateEscrowParams, opts?: RequestOptions): Promise<QueuedTx> {
    return this.http.post<QueuedTx>('/v1/payments/escrows', params, opts?.idempotencyKey);
  }

  /** Finish (release) an escrow. */
  async finishEscrow(
    escrowId: string,
    params: FinishEscrowParams,
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.post<QueuedTx>(
      `/v1/payments/escrows/${escrowId}/finish`,
      params,
      opts?.idempotencyKey,
    );
  }

  /** Cancel an expired escrow. */
  async cancelEscrow(
    escrowId: string,
    params: CancelEscrowParams,
    opts?: RequestOptions,
  ): Promise<QueuedTx> {
    return this.http.post<QueuedTx>(
      `/v1/payments/escrows/${escrowId}/cancel`,
      params,
      opts?.idempotencyKey,
    );
  }
}
