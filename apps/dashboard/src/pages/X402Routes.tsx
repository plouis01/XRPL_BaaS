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

  // Create form state. `assetPreset` is the dropdown selection — XRP and
  // RLUSD are the curated presets; "custom" reveals a free-text field for
  // `mpt:<48-hex>` or `iou:<CUR>:<issuer>`. We keep the resolved asset
  // string in `assetCustom` only when the preset is "custom".
  const [pathPattern, setPathPattern] = useState('');
  const [payeeAddress, setPayeeAddress] = useState('');
  const [assetPreset, setAssetPreset] = useState<'XRP' | 'RLUSD' | 'custom'>('XRP');
  const [assetCustom, setAssetCustom] = useState('');
  const [amount, setAmount] = useState('10000');
  const [submitting, setSubmitting] = useState(false);

  // Resolve the asset string the API expects. RLUSD is a server-side alias
  // (parseX402Asset expands it to the canonical IOU), so we just pass it
  // through verbatim — the server is the single source of truth for which
  // issuer the alias resolves to on the current network.
  const resolvedAsset = assetPreset === 'custom' ? assetCustom : assetPreset;

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
          asset: resolvedAsset,
          amount,
        },
      });
      setPathPattern('');
      setPayeeAddress('');
      setAmount('10000');
      setAssetPreset('XRP');
      setAssetCustom('');
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
          <select
            value={assetPreset}
            onChange={(e) => setAssetPreset(e.target.value as 'XRP' | 'RLUSD' | 'custom')}
            style={inputStyle}
          >
            <option value="XRP">XRP (native)</option>
            <option value="RLUSD">RLUSD (Ripple USD)</option>
            <option value="custom">Custom (mpt: or iou:)</option>
          </select>
          {assetPreset === 'custom' && (
            <input
              value={assetCustom}
              onChange={(e) => setAssetCustom(e.target.value)}
              placeholder="mpt:<48-hex> or iou:<CUR>:<issuer>"
              required
              style={{ ...inputStyle, marginTop: 6 }}
            />
          )}
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
                  ) : r.asset_kind === 'mpt' ? (
                    <code>mpt:{(r.asset_key ?? '').slice(0, 8)}...</code>
                  ) : r.asset_kind === 'iou' ? (
                    // asset_key for iou is "<CUR>:<issuer>". Show currency
                    // plus a short issuer hash so RLUSD reads as "RLUSD"
                    // even though it's stored as an IOU. Use safe lookups
                    // so a malformed key (no `:`) still renders.
                    (() => {
                      const parts = (r.asset_key ?? '').split(':');
                      const cur = parts[0] ?? '';
                      const iss = parts[1] ?? '';
                      return (
                        <code>
                          {cur}
                          {iss ? `:${iss.slice(0, 6)}...` : ''}
                        </code>
                      );
                    })()
                  ) : (
                    <code>{r.asset_kind}</code>
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
