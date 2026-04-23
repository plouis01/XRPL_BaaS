import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { Account, AccountBalances, Network, Token } from '../types.ts';

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
  const [showCreate, setShowCreate] = useState(false);

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
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          margin: '0 0 24px',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24 }}>Tokens</h1>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          style={{
            padding: '6px 12px',
            background: showCreate ? '#e2e8f0' : '#2563eb',
            color: showCreate ? '#1e293b' : '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          {showCreate ? 'Cancel' : '+ New token'}
        </button>
      </div>

      {showCreate && (
        <NewTokenForm
          network={network}
          onCreated={() => {
            setShowCreate(false);
            void fetchTokens();
          }}
        />
      )}

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

  // Poll /v1/dashboard/transactions/:id until the worker writes a terminal
  // status. `validated` + `failed` are terminal; `queued` / `submitting` /
  // `submitted` are in-flight and trigger another poll. We cap at ~30s
  // (15 polls * 2s) so a stuck worker doesn't leave the UI spinning forever.
  const pollTransaction = async (
    txId: string,
  ): Promise<{
    status: string;
    result_code: string | null;
    tx_hash: string | null;
  }> => {
    for (let i = 0; i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const tx = await api<{
          status: string;
          result_code: string | null;
          tx_hash: string | null;
        }>(`/v1/dashboard/transactions/${txId}`);
        if (tx.status === 'validated' || tx.status === 'failed') return tx;
      } catch {
        // Transient poll failure — try again until the cap expires.
      }
    }
    return { status: 'timeout', result_code: null, tx_hash: null };
  };

  // Translate a terminal tx state into a user-facing message. The most
  // load-bearing line here is the tecDUPLICATE mapping — that's the
  // 'holder already opted in' case the user hit in testing, which looks
  // like a failure but is effectively a no-op idempotent replay.
  const describeOutcome = (
    status: string,
    resultCode: string | null,
    unauthorizeFlag: boolean,
  ): string => {
    if (status === 'validated') {
      return unauthorizeFlag ? 'Unauthorized ✓' : 'Authorized ✓';
    }
    if (status === 'timeout') {
      return 'Still pending — check Transactions tab for the outcome.';
    }
    if (resultCode === 'tecDUPLICATE') {
      return 'Already authorized (on-chain MPToken object exists for this holder).';
    }
    if (resultCode === 'tecNO_PERMISSION') {
      return 'tecNO_PERMISSION — issuer cannot opt-in to its own MPT, or the issuance requires pre-authorization.';
    }
    if (resultCode === 'tecHAS_OBLIGATIONS') {
      return 'tecHAS_OBLIGATIONS — the holder still owns a non-zero balance. Transfer it back to the issuer (or clawback if enabled) before unauthorizing.';
    }
    return `Failed: ${resultCode ?? 'unknown'}`;
  };

  const authorize = async () => {
    if (!holder) return;
    // Pre-submit guard: the issuer cannot opt-in to its own MPT — rippled
    // returns tecNO_PERMISSION. Catch this client-side so the user gets an
    // explanation instead of a confusing failure.
    if (holder.trim() === token.issuer_address) {
      setAuthResult(
        'The issuer has implicit access to its own MPT and cannot opt in as a holder. Use a different holder address.',
      );
      return;
    }
    setAuthorizing(true);
    setAuthResult('Queued, waiting for ledger validation…');
    try {
      const res = await api<{ tx_id: string; status: string }>(`/v1/tokens/${token.id}/authorize`, {
        method: 'POST',
        body: { holder, unauthorize },
      });
      const outcome = await pollTransaction(res.tx_id);
      setAuthResult(describeOutcome(outcome.status, outcome.result_code, unauthorize));
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

// Inline "+ New token" form. Wraps POST /v1/tokens. The issuer dropdown is
// populated from /v1/dashboard/accounts — a client must have at least one
// managed account before they can issue, since the token's issuer is an
// XRPL account held by RailForge. MPT is the default (see CLAUDE.md);
// trustline remains an opt-in for DEX-liquidity use cases, exposed here
// via the type radio.
function NewTokenForm({
  network,
  onCreated,
}: {
  network: Network;
  onCreated: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [issuer, setIssuer] = useState('');
  const [tokenType, setTokenType] = useState<'mpt' | 'trustline'>('mpt');
  const [currencyCode, setCurrencyCode] = useState('');
  const [transferFee, setTransferFee] = useState('0');
  const [clawback, setClawback] = useState(true);
  const [freezeEnabled, setFreezeEnabled] = useState(true);
  const [maxSupply, setMaxSupply] = useState('');
  const [trustlineLimit, setTrustlineLimit] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingAccounts(true);
    setAccountsError(null);
    (async () => {
      try {
        const data = await api<{ data: Account[] }>(
          `/v1/dashboard/accounts?environment=${network}`,
        );
        if (cancelled) return;
        setAccounts(data.data);
        // Auto-select the first funded account — the most common case. If
        // nothing is funded we leave it blank and let the user pick; the
        // submit button will surface the backend's unfunded-issuer error.
        const firstFunded = data.data.find((a) => a.is_funded);
        if (firstFunded) setIssuer(firstFunded.address);
      } catch (err) {
        if (!cancelled) setAccountsError(errorMessage(err));
      } finally {
        if (!cancelled) setLoadingAccounts(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network]);

  const submit = async () => {
    if (!issuer || !currencyCode) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // transferFee is free-form input; coerce at the boundary. The backend
      // Zod schema will still reject out-of-range values, but parsing here
      // keeps the request body typed correctly.
      const feeBps = Number.parseInt(transferFee, 10);
      const body: Record<string, unknown> = {
        issuer,
        type: tokenType,
        currency_code: currencyCode,
        transfer_fee: Number.isFinite(feeBps) ? feeBps : 0,
        clawback,
        freeze_enabled: freezeEnabled,
      };
      if (maxSupply.trim()) body.max_supply = maxSupply.trim();
      if (tokenType === 'trustline' && trustlineLimit.trim()) {
        body.trustline_limit = trustlineLimit.trim();
      }
      await api<{ id: string; tx_id: string }>('/v1/tokens', {
        method: 'POST',
        body,
      });
      onCreated();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    color: '#64748b',
    marginBottom: 4,
  };
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    borderRadius: 4,
    border: '1px solid #cbd5e1',
    fontSize: 13,
    boxSizing: 'border-box',
  };

  return (
    <div
      style={{
        border: '1px solid #cbd5e1',
        borderRadius: 6,
        padding: 16,
        background: '#f8fafc',
        marginBottom: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <label style={labelStyle} htmlFor="ntf-issuer">
          Issuer account
        </label>
        {loadingAccounts ? (
          <span style={{ fontSize: 13, color: '#64748b' }}>Loading accounts…</span>
        ) : accountsError ? (
          <span style={{ fontSize: 13, color: '#991b1b' }}>{accountsError}</span>
        ) : accounts.length === 0 ? (
          <span style={{ fontSize: 13, color: '#64748b' }}>
            No managed accounts yet. Create one via <code>POST /v1/accounts</code> before issuing.
          </span>
        ) : (
          <select
            id="ntf-issuer"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            style={{ ...inputStyle, fontFamily: 'monospace' }}
          >
            <option value="">— pick an account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.address} disabled={!a.is_funded}>
                {a.address}
                {a.label ? ` (${a.label})` : ''}
                {a.is_funded ? '' : ' [unfunded]'}
              </option>
            ))}
          </select>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <span style={labelStyle}>Type</span>
          <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
            <label>
              <input
                type="radio"
                name="ntf-type"
                value="mpt"
                checked={tokenType === 'mpt'}
                onChange={() => setTokenType('mpt')}
              />{' '}
              MPT (default)
            </label>
            <label>
              <input
                type="radio"
                name="ntf-type"
                value="trustline"
                checked={tokenType === 'trustline'}
                onChange={() => setTokenType('trustline')}
              />{' '}
              Trustline
            </label>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="ntf-currency">
            Currency code
          </label>
          <input
            id="ntf-currency"
            type="text"
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value)}
            placeholder={tokenType === 'trustline' ? 'USD' : 'USDC'}
            maxLength={40}
            style={inputStyle}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="ntf-fee">
            Transfer fee (bps, 0–50000)
          </label>
          <input
            id="ntf-fee"
            type="number"
            min={0}
            max={50000}
            value={transferFee}
            onChange={(e) => setTransferFee(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="ntf-supply">
            Max supply (optional)
          </label>
          <input
            id="ntf-supply"
            type="text"
            value={maxSupply}
            onChange={(e) => setMaxSupply(e.target.value)}
            placeholder="unbounded if blank"
            style={inputStyle}
          />
        </div>
      </div>

      {tokenType === 'trustline' && (
        <div>
          <label style={labelStyle} htmlFor="ntf-tl-limit">
            Trustline limit
          </label>
          <input
            id="ntf-tl-limit"
            type="text"
            value={trustlineLimit}
            onChange={(e) => setTrustlineLimit(e.target.value)}
            placeholder="1000000"
            style={inputStyle}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 20, fontSize: 13, color: '#475569' }}>
        <label>
          <input
            type="checkbox"
            checked={clawback}
            onChange={(e) => setClawback(e.target.checked)}
            style={{ marginRight: 4 }}
          />
          Clawback
        </label>
        <label>
          <input
            type="checkbox"
            checked={freezeEnabled}
            onChange={(e) => setFreezeEnabled(e.target.checked)}
            style={{ marginRight: 4 }}
          />
          Freeze
        </label>
      </div>

      {submitError && <div style={{ fontSize: 12, color: '#991b1b' }}>{submitError}</div>}

      <div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !issuer || !currencyCode}
          style={{
            padding: '8px 16px',
            background: submitting || !issuer || !currencyCode ? '#cbd5e1' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: submitting || !issuer || !currencyCode ? 'not-allowed' : 'pointer',
            fontSize: 13,
          }}
        >
          {submitting ? 'Queueing…' : 'Issue token'}
        </button>
      </div>
    </div>
  );
}
