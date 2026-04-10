// Low-level HTTP client used by resource classes.
// Handles base URL, auth header, idempotency keys, and error parsing.

import type { ApiError } from './types.ts';

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class RailForgeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: ApiError | null,
  ) {
    super(message);
    this.name = 'RailForgeError';
  }
}

export class HttpClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(opts: HttpClientOptions) {
    // Strip trailing slash
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>('POST', path, body, idempotencyKey);
  }

  async put<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>('PUT', path, body, idempotencyKey);
  }

  async delete<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>('DELETE', path, body, idempotencyKey);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'X-Api-Key': this.apiKey,
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    // State-changing methods need an idempotency key.
    // Use caller-provided key for retries, or auto-generate one.
    if (method !== 'GET') {
      headers['Idempotency-Key'] = idempotencyKey ?? crypto.randomUUID();
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // 204 No Content (e.g. webhook delete)
    if (res.status === 204) {
      return null as T;
    }

    const json = await res.json();

    if (!res.ok) {
      const apiError = json as ApiError;
      throw new RailForgeError(apiError.error ?? `HTTP ${res.status}`, res.status, apiError);
    }

    return json as T;
  }
}
