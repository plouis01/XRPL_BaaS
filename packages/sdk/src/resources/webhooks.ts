import type { HttpClient } from '../http.ts';
import type {
  CreateWebhookEndpointParams,
  WebhookEndpointList,
  WebhookEndpointWithSecret,
} from '../types.ts';

export class Webhooks {
  constructor(private http: HttpClient) {}

  /** Register a new webhook endpoint. Returns the signing secret (shown only once). */
  async create(params: CreateWebhookEndpointParams): Promise<WebhookEndpointWithSecret> {
    return this.http.post<WebhookEndpointWithSecret>('/v1/webhooks/endpoints', params);
  }

  /** List all webhook endpoints (secrets are not included). */
  async list(): Promise<WebhookEndpointList> {
    return this.http.get<WebhookEndpointList>('/v1/webhooks/endpoints');
  }

  /** Delete a webhook endpoint. */
  async delete(endpointId: string): Promise<void> {
    await this.http.delete<null>(`/v1/webhooks/endpoints/${endpointId}`);
  }
}
