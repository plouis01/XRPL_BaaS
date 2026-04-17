// Shared API client for the dashboard.
//
// Auth model: the dashboard stores an API key in localStorage under
// `railforge_api_key`. Every request sends it as `X-API-Key`. No session
// cookies, no refresh tokens — the key is the session. If no key is
// present we prompt once at the module level.
//
// The key can be created from inside the app (see the ApiKeys page) once
// the user has at least one key to authenticate with. First-time users
// will need a key seeded directly in the DB (or via a follow-up
// bootstrap endpoint) — that's a separate onboarding concern.

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';
const STORAGE_KEY = 'railforge_api_key';

function getStoredKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeKey(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // localStorage can be disabled (private mode, quotas, etc.). The app
    // remains usable for the session since we fall back to prompting.
  }
}

/**
 * Returns the API key from storage, prompting once if absent. The prompt
 * is a last-resort UX — ApiKeys.tsx offers an in-app UI but obviously
 * needs an auth'd request to render. Catch-22 bootstrap solved by this
 * prompt.
 */
export function getApiKey(): string | null {
  const existing = getStoredKey();
  if (existing) return existing;
  // `prompt` is synchronous and blocks the thread — fine on the
  // dashboard because this runs at most once per session.
  const entered = window.prompt('Enter your RailForge API key (rf_test_… or rf_live_…):');
  if (entered && /^rf_(test|live)_/.test(entered)) {
    storeKey(entered);
    return entered;
  }
  return null;
}

/** Overwrite the stored key. Used by the ApiKeys page after create. */
export function setApiKey(value: string): void {
  storeKey(value);
}

/** Clear the stored key — e.g. on auth-failure response. */
export function clearApiKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no-op */
  }
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  /** Extra headers, merged after Authorization. */
  headers?: Record<string, string>;
  /** If true, skip the auth header (only needed for public endpoints). */
  anonymous?: boolean;
}

/**
 * Fetch wrapper that threads the API key through as `X-API-Key`.
 * Returns the parsed JSON body on 2xx, or throws with the response for
 * error handling. The caller can `try/catch` to render a banner.
 */
export async function api<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };

  if (!opts.anonymous) {
    const key = getApiKey();
    if (key) headers['X-API-Key'] = key;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (res.status === 401) {
    // The stored key is invalid — drop it so the next call re-prompts.
    clearApiKey();
  }
  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, bodyText);
  }
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
