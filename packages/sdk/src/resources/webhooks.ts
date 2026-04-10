import type { HttpClient } from '../http.ts';
import type {
  CreateWebhookEndpointParams,
  RequestOptions,
  WebhookEndpointList,
  WebhookEndpointWithSecret,
} from '../types.ts';

export class Webhooks {
  constructor(private http: HttpClient) {}

  /** Register a new webhook endpoint. Returns the signing secret (shown only once). */
  async create(
    params: CreateWebhookEndpointParams,
    opts?: RequestOptions,
  ): Promise<WebhookEndpointWithSecret> {
    return this.http.post<WebhookEndpointWithSecret>(
      '/v1/webhooks/endpoints',
      params,
      opts?.idempotencyKey,
    );
  }

  /** List all webhook endpoints (secrets are not included). */
  async list(): Promise<WebhookEndpointList> {
    return this.http.get<WebhookEndpointList>('/v1/webhooks/endpoints');
  }

  /** Delete a webhook endpoint. */
  async delete(endpointId: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete<null>(
      `/v1/webhooks/endpoints/${endpointId}`,
      undefined,
      opts?.idempotencyKey,
    );
  }
}
