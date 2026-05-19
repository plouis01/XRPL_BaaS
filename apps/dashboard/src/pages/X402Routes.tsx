// Dashboard CRUD page for x402 gated routes (SPRINT_10_PLAN §8).
//
// Uses the authenticated /v1/x402/* surface directly — the dashboard's
// cookie auth feeds into the same auth chain the SDK + server-to-server
// callers go through, so no /v1/dashboard/* shim is needed.
//
// Surface mirrors the Domains page: read-only list + a small inline form
// to create a route + a delete button per row. We don't expose an "edit"
// flow this sprint (route mutations would race with already-issued
// intents); to change a route, delete and re-create.

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { Network, X402Route } from '../types.ts';

interface RouteList {
  routes: X402Route[];
}

export function X402Routes({ network }: { network: Network }) {
  const [routes, setRoutes] = useState<X402Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state.
  const [pathPattern, setPathPattern] = useState('');
  const [payeeAddress, setPayeeAddress] = useState('');
  const [asset, setAsset] = useState('XRP');
  const [amount, setAmount] = useState('10000');
  const [submitting, setSubmitting] = useState(false);

  const fetchRoutes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<RouteList>('/v1/x402/routes');
      setRoutes(data.routes ?? []);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`Failed to load (${err.status})`);
      } else {
        setError('Failed to load routes');
      }
      setRoutes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRoutes();
  }, [fetchRoutes]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api<X402Route>('/v1/x402/routes', {
        method: 'POST',
        body: {
          path_pattern: pathPattern,
          payee_address: payeeAddress,
          asset,
          amount,
        },
      });
      setPathPattern('');
      setPayeeAddress('');
      setAmount('10000');
      setAsset('XRP');
      await fetchRoutes();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`Create failed (${err.status})`);
      } else {
        setError('Create failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this route? Existing intents stay valid until they expire.')) return;
    try {
      await api<void>(`/v1/x402/routes/${id}`, { method: 'DELETE' });
      await fetchRoutes();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`Delete failed (${err.status})`);
      } else {
        setError('Delete failed');
      }
    }
  };

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24 }}>x402 Routes</h1>

      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
        Showing <strong>{network}</strong> gated routes. Clients pay these prices via x402 to access
        the registered paths.
      </div>

      {error && (
        <div
          style={{
            color: '#b91c1c',
            background: '#fef2f2',
            padding: '8px 12px',
            borderRadius: 4,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => void handleCreate(e)}
        style={{
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          padding: 16,
          borderRadius: 6,
          marginBottom: 24,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Path pattern
          <input
            value={pathPattern}
            onChange={(e) => setPathPattern(e.target.value)}
            placeholder="/v1/your-resource"
            required
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Payee address (r...)
          <input
            value={payeeAddress}
            onChange={(e) => setPayeeAddress(e.target.value)}
            placeholder="rEHMTjmCNgxiGzgUTpV4Y1MwYpFpYz7e7p"
            required
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Asset
          <input
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
            placeholder="XRP or mpt:<48-hex>"
            required
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Amount (smallest units)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="10000 (drops for XRP)"
            required
            style={inputStyle}
          />
        </label>
        <button
          type="submit"
          disabled={submitting}
          style={{
            gridColumn: '1 / -1',
            padding: '8px 12px',
            background: submitting ? '#cbd5e1' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: submitting ? 'wait' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {submitting ? 'Creating...' : 'Add route'}
        </button>
      </form>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading...</p>
      ) : routes.length === 0 ? (
        <p style={{ color: '#64748b' }}>No gated routes yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>Path</th>
              <th style={{ padding: '8px 12px' }}>Payee</th>
              <th style={{ padding: '8px 12px' }}>Asset</th>
              <th style={{ padding: '8px 12px' }}>Price</th>
              <th style={{ padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
              <th style={{ padding: '8px 12px', width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  <code>{r.path_pattern}</code>
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  <code>
                    {r.payee_address.slice(0, 10)}...{r.payee_address.slice(-4)}
                  </code>
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  {r.asset_kind === 'xrp' ? (
                    'XRP'
                  ) : (
                    <code>mpt:{(r.asset_key ?? '').slice(0, 8)}...</code>
                  )}
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>{r.price_amount}</td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  {r.is_active ? (
                    <span style={{ color: '#16a34a' }}>active</span>
                  ) : (
                    <span style={{ color: '#94a3b8' }}>deleted</span>
                  )}
                </td>
                <td
                  style={{
                    padding: '8px 12px',
                    fontSize: 12,
                    color: '#64748b',
                  }}
                >
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  {r.is_active && (
                    <button
                      type="button"
                      onClick={() => void handleDelete(r.id)}
                      style={{
                        padding: '4px 10px',
                        background: 'transparent',
                        border: '1px solid #cbd5e1',
                        borderRadius: 4,
                        color: '#dc2626',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  marginTop: 4,
  padding: '6px 8px',
  borderRadius: 4,
  border: '1px solid #cbd5e1',
  fontSize: 13,
  fontFamily: 'inherit',
};
