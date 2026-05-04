import { useState } from 'react';
import { ApiError, login, signup } from '../api.ts';

type Mode = 'signin' | 'signup';

export function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [apiKey, setApiKey] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a successful signup we surface the raw key once so the user can
  // copy it before the page transitions. Auto-login happens regardless.
  const [mintedKey, setMintedKey] = useState<string | null>(null);

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
      setMintedKey(result.api_key);
      // Auto-login with the freshly minted key. The user still sees the
      // key once on screen so they can stash it elsewhere if they want.
      await login(result.api_key);
      // Brief pause so the user can see the key before the page swaps.
      setTimeout(() => onLoggedIn(), 1500);
    } catch (err) {
      setError(formatError(err));
      setSubmitting(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setMintedKey(null);
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
            <div style={{ fontWeight: 600, marginBottom: 4 }}>API key (copy now — shown once):</div>
            <code
              style={{
                fontFamily: 'ui-monospace, Menlo, monospace',
                wordBreak: 'break-all',
                fontSize: 11,
              }}
            >
              {mintedKey}
            </code>
          </div>
        )}

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
