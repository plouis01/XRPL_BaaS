import { useState } from 'react';
import { ApiError, login } from '../api.ts';

export function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(apiKey.trim());
      onLoggedIn();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 401 ? 'Invalid or revoked API key.' : `API error ${err.status}.`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Unknown error.');
      }
    } finally {
      setSubmitting(false);
    }
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
        onSubmit={submit}
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
          Paste an API key to start a session.
        </p>

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

        <button
          type="submit"
          disabled={submitting || apiKey.trim().length === 0}
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
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>

        <p style={{ marginTop: 16, fontSize: 12, color: '#64748b' }}>
          No key yet? Run <code>bun run scripts/seed-dev.ts</code> to mint one.
        </p>
      </form>
    </div>
  );
}
