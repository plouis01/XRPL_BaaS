import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, login, signup } from '../api.ts';

type Mode = 'signin' | 'signup';

export function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  // Honor `?mode=signup` so the Landing page CTA can deep-link straight
  // into the create-account form. Anything else falls back to sign-in.
  const [searchParams] = useSearchParams();
  const initialMode: Mode = searchParams.get('mode') === 'signup' ? 'signup' : 'signin';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [apiKey, setApiKey] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a successful signup we surface the raw key once so the user can
  // copy it before the page transitions. The user must click Continue —
  // we never auto-redirect, because the key is shown ONCE and a too-short
  // timeout means a user who blinked has to revoke + reseed.
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const formatError = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.status === 401) return 'Invalid or revoked API key.';
      if (err.status === 404) return 'Signup is disabled on this server.';
      if (err.status === 400) return 'Invalid email or name.';
      return `API error ${err.status}.`;
    }
    if (err instanceof Error) return err.message;
    return 'Unknown error.';
  };

  const submitSignin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(apiKey.trim());
      onLoggedIn();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signup(email.trim(), name.trim());
      // Set the cookie session in the background so the eventual Continue
      // click is a no-op redirect. The key stays on screen until the user
      // explicitly continues — no race with a copy-paste.
      await login(result.api_key);
      setMintedKey(result.api_key);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const copyKey = async () => {
    if (!mintedKey) return;
    try {
      await navigator.clipboard.writeText(mintedKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail on insecure origins or strict permissions —
      // fall back to leaving the key on screen for manual selection.
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setMintedKey(null);
    setCopied(false);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        background: '#f8fafc',
      }}
    >
      <form
        onSubmit={mode === 'signin' ? submitSignin : submitSignup}
        style={{
          background: '#fff',
          padding: 32,
          borderRadius: 8,
          border: '1px solid #e2e8f0',
          width: 400,
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}
      >
        <h1 style={{ margin: '0 0 8px', fontSize: 20 }}>RailForge Dashboard</h1>
        <p style={{ margin: '0 0 24px', color: '#64748b', fontSize: 14 }}>
          {mode === 'signin'
            ? 'Paste an API key to start a session.'
            : 'Create a dev account and a testnet API key.'}
        </p>

        {mode === 'signin' ? (
          <>
            <label htmlFor="api-key" style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
              API key
            </label>
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="rf_test_..."
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: 13,
                boxSizing: 'border-box',
              }}
            />
          </>
        ) : (
          <>
            <label
              htmlFor="signup-name"
              style={{ display: 'block', fontSize: 13, marginBottom: 6 }}
            >
              Name
            </label>
            <input
              id="signup-name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Dev"
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontSize: 13,
                boxSizing: 'border-box',
              }}
            />
            <label
              htmlFor="signup-email"
              style={{
                display: 'block',
                fontSize: 13,
                marginTop: 12,
                marginBottom: 6,
              }}
            >
              Email
            </label>
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="dev@example.com"
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontSize: 13,
                boxSizing: 'border-box',
              }}
            />
          </>
        )}

        {error && (
          <div
            style={{
              marginTop: 12,
              padding: '8px 10px',
              background: '#fee2e2',
              border: '1px solid #fca5a5',
              color: '#991b1b',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {mintedKey && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              background: '#ecfdf5',
              border: '1px solid #6ee7b7',
              color: '#065f46',
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 6,
              }}
            >
              <span style={{ fontWeight: 600 }}>API key (shown once — copy it now):</span>
              <button
                type="button"
                onClick={() => void copyKey()}
                style={{
                  background: copied ? '#065f46' : '#fff',
                  color: copied ? '#fff' : '#065f46',
                  border: '1px solid #6ee7b7',
                  borderRadius: 4,
                  padding: '2px 8px',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <code
              style={{
                fontFamily: 'ui-monospace, Menlo, monospace',
                wordBreak: 'break-all',
                fontSize: 11,
                userSelect: 'all',
              }}
            >
              {mintedKey}
            </code>
            <div style={{ marginTop: 6, color: '#047857', fontSize: 11 }}>
              Stash it in a password manager — the dashboard cannot show it again. You can mint
              another from API Keys after continuing.
            </div>
          </div>
        )}

        {mintedKey ? (
          <button
            type="button"
            onClick={() => onLoggedIn()}
            style={{
              marginTop: 16,
              width: '100%',
              padding: '10px 16px',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Continue to dashboard
          </button>
        ) : (
          <button
            type="submit"
            disabled={
              submitting ||
              (mode === 'signin'
                ? apiKey.trim().length === 0
                : email.trim().length === 0 || name.trim().length === 0)
            }
            style={{
              marginTop: 16,
              width: '100%',
              padding: '10px 16px',
              background: submitting ? '#93c5fd' : '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontWeight: 500,
            }}
          >
            {submitting
              ? mode === 'signin'
                ? 'Signing in...'
                : 'Creating account...'
              : mode === 'signin'
                ? 'Sign in'
                : 'Create account'}
          </button>
        )}

        <p style={{ marginTop: 16, fontSize: 12, color: '#64748b' }}>
          {mode === 'signin' ? (
            <>
              No key yet?{' '}
              <button
                type="button"
                onClick={() => switchMode('signup')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  color: '#2563eb',
                  cursor: 'pointer',
                  fontSize: 12,
                  textDecoration: 'underline',
                }}
              >
                Create one
              </button>
              .
            </>
          ) : (
            <>
              Already have a key?{' '}
              <button
                type="button"
                onClick={() => switchMode('signin')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  color: '#2563eb',
                  cursor: 'pointer',
                  fontSize: 12,
                  textDecoration: 'underline',
                }}
              >
                Sign in
              </button>
              .
            </>
          )}
        </p>
      </form>
    </div>
  );
}
