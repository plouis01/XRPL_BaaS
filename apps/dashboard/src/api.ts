// Shared API client for the dashboard.
//
// REVIEW.md HIGH-03: auth model is now cookie-backed, not localStorage.
//
// The dashboard POSTs the API key exactly once to `/v1/dashboard/session`
// (`login(apiKey)` below). The server validates it and sets an httpOnly,
// SameSite=Strict, Secure cookie containing the key. Every subsequent
// request uses `credentials: 'include'` so the browser attaches the
// cookie automatically — the key is never readable from JS, which
// closes the XSS-exfiltration vector.
//
// Logout (`logout()`) calls DELETE /v1/dashboard/session which clears
// the cookie client-side. It does NOT revoke the underlying API key —
// that's a separate action via /v1/dashboard/keys/:id/revoke.
//
// First-time onboarding: the user still needs an API key to log in. The
// login form in the dashboard UI collects the key and calls `login`.
// Creating new keys happens via the ApiKeys page after login.

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

/**
 * Log in by handing the server the API key. On success the server sets
 * the httpOnly session cookie and returns 204. The key is NOT stored
 * client-side at any point — the browser owns it from here on.
 *
 * Throws ApiError on 4xx/5xx.
 */
export async function login(apiKey: string): Promise<void> {
  if (!/^rf_(test|live)_/.test(apiKey)) {
    throw new Error('Invalid API key format');
  }
  const res = await fetch(`${API_BASE}/v1/dashboard/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, bodyText);
  }
}

/**
 * Mint a fresh testnet client + API key from the login UI. Gated server-
 * side: registered in non-production by default, or in production when
 * `RAILFORGE_ALLOW_SIGNUP=1` is set. Returns 404 when the gate is closed.
 *
 * The response also includes an auto-created `parent_address` (or null if
 * treasury funding is unavailable). Callers should immediately POST the
 * key to /v1/dashboard/session via `login`.
 */
export interface SignupResult {
  api_key: string;
  client_id: string;
  environment: 'testnet';
  /**
   * Auto-created "parent" XRPL account address for the new client. May be
   * null if treasury funding is not configured on the API or the
   * account-creation enqueue failed — signup itself still succeeds and
   * the user can mint a parent account manually later.
   */
  parent_address: string | null;
}

export async function signup(email: string, name: string): Promise<SignupResult> {
  const res = await fetch(`${API_BASE}/v1/dashboard/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  });
  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, bodyText);
  }
  return (await res.json()) as SignupResult;
}

/**
 * Log out — clears the session cookie on the server. Does not revoke
 * the API key itself; the same key can be used to log in again.
 */
export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/v1/dashboard/session`, {
    method: 'DELETE',
    credentials: 'include',
  });
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  /** Extra headers, merged in. */
  headers?: Record<string, string>;
}

/**
 * Fetch wrapper that sends the session cookie via `credentials: 'include'`.
 * Returns the parsed JSON body on 2xx, or throws with the response for
 * error handling. A 401 means the session cookie is missing/expired — the
 * caller should redirect to the login form.
 */
// Methods that require an Idempotency-Key header per the API contract
// (enforced by the idempotency middleware on every /v1/* state-changing
// route). Safe methods never need one.
const METHODS_REQUIRING_IDEMPOTENCY = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export async function api<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };

  if (METHODS_REQUIRING_IDEMPOTENCY.has(method) && !('Idempotency-Key' in headers)) {
    headers['Idempotency-Key'] = crypto.randomUUID();
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, bodyText);
  }
  // 204 No Content has no body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API error ${status}: ${body.slice(0, 200)}`);
    this.name = 'ApiError';
  }
}
