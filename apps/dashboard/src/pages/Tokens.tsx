import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { AccountBalances, Network, Token } from '../types.ts';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `API error ${err.status}: ${err.body.slice(0, 160)}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

// Format MPT amount / issued-currency balance as-is — both already come back
// as decimal strings from the API. XRP is drops (1 XRP = 1_000_000 drops).
function formatDrops(drops: string): string {
  const n = Number(drops);
  if (!Number.isFinite(n)) return drops;
  return `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} XRP`;
}

export function Tokens({ network }: { network: Network }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ data: Token[] }>(`/v1/dashboard/tokens?environment=${network}`);
      setTokens(data.data);
    } catch (err) {
      setTokens([]);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    void fetchTokens();
  }, [fetchTokens]);

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24 }}>Tokens</h1>

      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
        Showing <strong>{network}</strong> issuances (MPT default, trustline opt-in)
      </div>

      {error && (
        <div
          style={{
            padding: 12,
            background: '#fee2e2',
            border: '1px solid #fca5a5',
            color: '#991b1b',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading...</p>
      ) : tokens.length === 0 ? (
        <p style={{ color: '#64748b' }}>
          No tokens yet. Issue one via <code>POST /v1/tokens</code> to see it here.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px', width: 28 }} />
              <th style={{ padding: '8px 12px' }}>Currency</th>
              <th style={{ padding: '8px 12px' }}>Type</th>
              <th style={{ padding: '8px 12px' }}>Issuer</th>
              <th style={{ padding: '8px 12px' }}>MPT Issuance ID</th>
              <th style={{ padding: '8px 12px' }}>Flags</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <TokenRow
                key={t.id}
                token={t}
                expanded={expanded === t.id}
                onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TokenRow({
  token,
  expanded,
  onToggle,
}: {
  token: Token;
  expanded: boolean;
  onToggle: () => void;
}) {
  const flags: string[] = [];
  if (token.token_type === 'mpt') {
    if (token.clawback) flags.push('clawback');
    if (token.freeze_enabled) flags.push('freeze');
    if (token.transfer_fee > 0) flags.push(`fee ${token.transfer_fee}bps`);
  }

  return (
    <>
      <tr
        style={{ borderBottom: '1px solid #e2e8f0', cursor: 'pointer' }}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <td style={{ padding: '8px 12px', color: '#64748b' }}>{expanded ? '▾' : '▸'}</td>
        <td style={{ padding: '8px 12px' }}>
          <code>{token.currency_code}</code>
        </td>
        <td style={{ padding: '8px 12px', fontSize: 13 }}>
          <span
            style={{
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: 9999,
              fontSize: 11,
              fontWeight: 500,
              background: token.token_type === 'mpt' ? '#dbeafe' : '#fef3c7',
              color: token.token_type === 'mpt' ? '#1e40af' : '#92400e',
            }}
          >
            {token.token_type}
          </span>
        </td>
        <td style={{ padding: '8px 12px', fontSize: 13 }}>
          <code>{token.issuer_address.slice(0, 10)}...</code>
        </td>
        <td style={{ padding: '8px 12px', fontSize: 12 }}>
          {token.mpt_issuance_id ? (
            <code>{token.mpt_issuance_id.slice(0, 12)}...</code>
          ) : (
            <span style={{ color: '#94a3b8' }}>—</span>
          )}
        </td>
        <td style={{ padding: '8px 12px', fontSize: 12, color: '#475569' }}>
          {flags.length === 0 ? <span style={{ color: '#94a3b8' }}>—</span> : flags.join(', ')}
        </td>
        <td style={{ padding: '8px 12px', fontSize: 13 }}>
          {token.created_at ? new Date(token.created_at).toLocaleDateString() : '—'}
        </td>
      </tr>
      {expanded && (
        <tr style={{ borderBottom: '1px solid #e2e8f0', background: '#f8fafc' }}>
          <td colSpan={7} style={{ padding: '16px 24px' }}>
            <TokenDetail token={token} />
          </td>
        </tr>
      )}
    </>
  );
}

function TokenDetail({ token }: { token: Token }) {
  const [balances, setBalances] = useState<AccountBalances | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [holder, setHolder] = useState('');
  const [unauthorize, setUnauthorize] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [authResult, setAuthResult] = useState<string | null>(null);

  const fetchBalances = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<AccountBalances>(
        `/v1/accounts/${encodeURIComponent(token.issuer_address)}/balances`,
      );
      setBalances(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [token.issuer_address]);

  useEffect(() => {
    void fetchBalances();
  }, [fetchBalances]);

  const authorize = async () => {
    if (!holder) return;
    setAuthorizing(true);
    setAuthResult(null);
    try {
      const res = await api<{ tx_id: string; status: string }>(`/v1/tokens/${token.id}/authorize`, {
        method: 'POST',
        body: { holder, unauthorize },
      });
      setAuthResult(`Queued: tx_id=${res.tx_id}`);
    } catch (err) {
      setAuthResult(errorMessage(err));
    } finally {
      setAuthorizing(false);
    }
  };

  // Row-of-labels layout, kept minimal; full addresses + IDs are unabridged
  // here so the user can copy them.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Token ID</div>
        <code style={{ fontSize: 12 }}>{token.id}</code>
      </div>
      <div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Issuer address</div>
        <code style={{ fontSize: 12 }}>{token.issuer_address}</code>
      </div>
      {token.mpt_issuance_id && (
        <div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>MPT issuance ID</div>
          <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{token.mpt_issuance_id}</code>
        </div>
      )}
      {token.max_supply && (
        <div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Max supply</div>
          <code style={{ fontSize: 12 }}>{token.max_supply}</code>
        </div>
      )}

      <div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
          Issuer balances (live)
        </div>
        {loading ? (
          <span style={{ fontSize: 13, color: '#64748b' }}>Loading balances…</span>
        ) : error ? (
          <span style={{ fontSize: 13, color: '#991b1b' }}>{error}</span>
        ) : balances ? (
          <div
            style={{
              fontSize: 13,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div>
              XRP: <strong>{formatDrops(balances.xrp_drops)}</strong>
            </div>
            {token.token_type === 'mpt' && token.mpt_issuance_id && (
              <div>
                MPT held by issuer:{' '}
                <strong>
                  {balances.mpts.find((m) => m.mpt_issuance_id === token.mpt_issuance_id)
                    ?.balance ?? '0'}
                </strong>
              </div>
            )}
            {token.token_type === 'trustline' && balances.trustlines.length > 0 && (
              <div>
                Trustlines: <strong>{balances.trustlines.length}</strong>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {token.token_type === 'mpt' && token.mpt_issuance_id && (
        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
            Authorize holder (MPTokenAuthorize)
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <input
              type="text"
              value={holder}
              onChange={(e) => setHolder(e.target.value)}
              placeholder="rHolderAddress..."
              style={{
                flex: '1 1 280px',
                padding: '6px 8px',
                borderRadius: 4,
                border: '1px solid #cbd5e1',
                fontFamily: 'monospace',
                fontSize: 13,
              }}
            />
            <label style={{ fontSize: 13, color: '#475569' }}>
              <input
                type="checkbox"
                checked={unauthorize}
                onChange={(e) => setUnauthorize(e.target.checked)}
                style={{ marginRight: 4 }}
              />
              Unauthorize
            </label>
            <button
              type="button"
              onClick={() => void authorize()}
              disabled={!holder || authorizing}
              style={{
                padding: '6px 12px',
                background: authorizing || !holder ? '#cbd5e1' : '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: authorizing || !holder ? 'not-allowed' : 'pointer',
                fontSize: 13,
              }}
            >
              {authorizing ? 'Submitting…' : unauthorize ? 'Unauthorize' : 'Authorize'}
            </button>
          </div>
          {authResult && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#475569' }}>{authResult}</div>
          )}
        </div>
      )}
    </div>
  );
}
