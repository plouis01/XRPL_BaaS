// Agents dashboard page (VISION.md agent launcher).
//
// Lists agents for the selected network and lets the tenant provision a
// new one inline. Detail row expands to show allowlist + spend caps; the
// detail fetch hits GET /v1/agents/:id (which never returns the seed).
//
// SEED HANDLING: the provisioning POST surfaces `agent_seed` exactly once
// in the 201 response. The page shows it in a copy-once banner directly
// after creation and clears it from React state on dismiss. It is never
// re-fetched, never persisted to localStorage, never logged.

import { Fragment, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { Account, Agent, AgentSummary, Network } from '../types.ts';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `API error ${err.status}: ${err.body.slice(0, 160)}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: '#fef3c7', text: '#92400e' },
  active: { bg: '#dcfce7', text: '#166534' },
  failed: { bg: '#fee2e2', text: '#991b1b' },
  revoked: { bg: '#f1f5f9', text: '#475569' },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: '#f1f5f9', text: '#475569' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 500,
        background: c.bg,
        color: c.text,
      }}
    >
      {status}
    </span>
  );
}

function formatDrops(drops: string | null): string {
  if (!drops) return 'no cap';
  const n = Number(drops);
  if (!Number.isFinite(n)) return drops;
  return `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} XRP`;
}

export function Agents({ network }: { network: Network }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [seedToShowOnce, setSeedToShowOnce] = useState<{
    seed: string;
    agentId: string;
  } | null>(null);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ data: AgentSummary[] }>(
        `/v1/dashboard/agents?environment=${network}`,
      );
      setAgents(data.data);
    } catch (err) {
      setAgents([]);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

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
        <h1 style={{ margin: 0, fontSize: 24 }}>Agents</h1>
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
          {showCreate ? 'Cancel' : '+ New agent'}
        </button>
      </div>

      {showCreate && (
        <NewAgentForm
          network={network}
          onCreated={(seed, agentId) => {
            setShowCreate(false);
            setSeedToShowOnce({ seed, agentId });
            void fetchAgents();
          }}
        />
      )}

      {seedToShowOnce && (
        <SeedOnceBanner
          seed={seedToShowOnce.seed}
          agentId={seedToShowOnce.agentId}
          onDismiss={() => setSeedToShowOnce(null)}
        />
      )}

      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
        Showing <strong>{network}</strong> agents (semi-custodial sub-account delegates)
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
      ) : agents.length === 0 ? (
        <p style={{ color: '#64748b' }}>
          No agents yet. Provision one with <code>POST /v1/agents</code> or the button above.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px', width: 28 }} />
              <th style={{ padding: '8px 12px' }}>Label</th>
              <th style={{ padding: '8px 12px' }}>Preset</th>
              <th style={{ padding: '8px 12px' }}>Parent</th>
              <th style={{ padding: '8px 12px' }}>Agent</th>
              <th style={{ padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const isOpen = expanded === a.id;
              return (
                <Fragment key={a.id}>
                  <tr
                    style={{
                      borderBottom: '1px solid #e2e8f0',
                      cursor: 'pointer',
                    }}
                    onClick={() => setExpanded(isOpen ? null : a.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpanded(isOpen ? null : a.id);
                      }
                    }}
                  >
                    <td style={{ padding: '8px 12px', color: '#64748b' }}>{isOpen ? '▾' : '▸'}</td>
                    <td style={{ padding: '8px 12px', fontSize: 13 }}>
                      {a.label ?? <span style={{ color: '#94a3b8' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 13 }}>{a.preset}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12 }}>
                      <code>{a.parent_address.slice(0, 10)}...</code>
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 12 }}>
                      <code>{a.agent_address.slice(0, 10)}...</code>
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <StatusBadge status={a.status} />
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 13 }}>
                      {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr
                      style={{
                        borderBottom: '1px solid #e2e8f0',
                        background: '#f8fafc',
                      }}
                    >
                      <td colSpan={7} style={{ padding: '16px 24px' }}>
                        <AgentDetail agentId={a.id} onStatusFlip={() => void fetchAgents()} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AgentDetail({
  agentId,
  onStatusFlip,
}: {
  agentId: string;
  onStatusFlip: () => void;
}) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tracks the last status we surfaced to the parent — when the agent flips
  // pending → active mid-poll, we trigger a single list refresh so the
  // table badge updates without a full page reload.
  const [lastStatus, setLastStatus] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    try {
      const data = await api<Agent>(`/v1/agents/${agentId}`);
      setAgent(data);
      setError(null);
      if (lastStatus !== null && lastStatus !== data.status) {
        onStatusFlip();
      }
      setLastStatus(data.status);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [agentId, lastStatus, onStatusFlip]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  // Light poll while the agent is pending — caller is waiting for the
  // SignerListSet validation to flip status to 'active' or 'failed'. Stop
  // polling once we've reached a terminal status.
  useEffect(() => {
    if (!agent || (agent.status !== 'pending' && agent.status !== 'submitting')) return;
    const t = setInterval(() => {
      void fetchDetail();
    }, 4000);
    return () => clearInterval(t);
  }, [agent, fetchDetail]);

  if (loading) return <span style={{ fontSize: 13, color: '#64748b' }}>Loading...</span>;
  if (error) return <span style={{ fontSize: 13, color: '#991b1b' }}>{error}</span>;
  if (!agent) return <span style={{ fontSize: 13, color: '#64748b' }}>Not found</span>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Agent ID" value={agent.id} mono />
      <Field label="Parent address" value={agent.parent_address} mono />
      <Field label="Agent address" value={agent.agent_address} mono />
      <Field label="Preset" value={agent.preset} mono={false} />
      <Field
        label="Created"
        value={agent.created_at ? new Date(agent.created_at).toLocaleString() : null}
        mono={false}
      />
      <div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Spend caps</div>
        <div style={{ fontSize: 13 }}>
          Per-tx: <strong>{formatDrops(agent.spend_policy?.max_xrp_per_tx_drops ?? null)}</strong>
          {'  ·  '}
          Daily: <strong>{formatDrops(agent.spend_policy?.daily_xrp_limit_drops ?? null)}</strong>
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
          Allowlist ({agent.allowlist?.length ?? 0})
        </div>
        {!agent.allowlist || agent.allowlist.length === 0 ? (
          <span style={{ fontSize: 12, color: '#94a3b8' }}>—</span>
        ) : (
          <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 13 }}>
            {agent.allowlist.map((e, i) => (
              <li key={`${e.entry_type}-${e.entry_value}-${i}`} style={{ marginBottom: 2 }}>
                <span
                  style={{
                    display: 'inline-block',
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: '#e2e8f0',
                    fontSize: 11,
                    marginRight: 6,
                  }}
                >
                  {e.entry_type}
                </span>
                <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{e.entry_value}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{label}</div>
      {value ? (
        mono ? (
          <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{value}</code>
        ) : (
          <span style={{ fontSize: 13 }}>{value}</span>
        )
      ) : (
        <span style={{ fontSize: 12, color: '#94a3b8' }}>—</span>
      )}
    </div>
  );
}

// Banner shown immediately after a successful POST /v1/agents. Surfaces the
// `agent_seed` ONCE — there is no recovery path. Dismissing clears it from
// React state so a hot reload or back-nav doesn't leak it.
function SeedOnceBanner({
  seed,
  agentId,
  onDismiss,
}: {
  seed: string;
  agentId: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(seed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API can fail in non-secure contexts; user can still
      // select the seed text manually.
    }
  };
  return (
    <div
      style={{
        padding: 16,
        marginBottom: 16,
        border: '2px solid #d97706',
        background: '#fffbeb',
        borderRadius: 6,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8, color: '#92400e' }}>
        Agent provisioned — copy the seed now (shown only once)
      </div>
      <div style={{ fontSize: 12, color: '#92400e', marginBottom: 8 }}>
        Agent <code>{agentId}</code>. Save the seed in your agent runtime or password manager.
        RailForge will not return it again on any GET.
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '8px 12px',
          background: '#fef3c7',
          borderRadius: 4,
          fontFamily: 'monospace',
          fontSize: 13,
          wordBreak: 'break-all',
        }}
      >
        <span style={{ flex: 1 }}>{seed}</span>
        <button
          type="button"
          onClick={() => void copy()}
          style={{
            padding: '4px 10px',
            background: '#d97706',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            padding: '4px 10px',
            background: 'transparent',
            color: '#92400e',
            border: '1px solid #d97706',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

const PRESET_DEFAULTS: Record<
  string,
  {
    description: string;
    requireAllowlist: boolean;
    allowedEntryTypes: Array<'destination' | 'token' | 'domain'>;
    maxXrpPerTx: string;
    dailyXrp: string;
  }
> = {
  'payment-agent': {
    description: 'Pay allowlisted destinations. 10 XRP/tx, 100 XRP/day default.',
    requireAllowlist: true,
    allowedEntryTypes: ['destination', 'token'],
    maxXrpPerTx: '10000000',
    dailyXrp: '100000000',
  },
  'treasury-agent': {
    description: 'Disburse to destinations or XLS-80 domain members. 1000/10000 XRP defaults.',
    requireAllowlist: false,
    allowedEntryTypes: ['destination', 'token', 'domain'],
    maxXrpPerTx: '1000000000',
    dailyXrp: '10000000000',
  },
};

function NewAgentForm({
  network,
  onCreated,
}: {
  network: Network;
  onCreated: (seed: string, agentId: string) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [preset, setPreset] = useState<'payment-agent' | 'treasury-agent'>('payment-agent');
  const [parent, setParent] = useState('');
  const [label, setLabel] = useState('');
  const [allowlistText, setAllowlistText] = useState('');
  const [allowlistType, setAllowlistType] = useState<'destination' | 'token' | 'domain'>(
    'destination',
  );
  const [overrideMaxPerTx, setOverrideMaxPerTx] = useState('');
  const [overrideDaily, setOverrideDaily] = useState('');

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
        const firstFunded = data.data.find((a) => a.is_funded);
        if (firstFunded) setParent(firstFunded.address);
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

  const presetCfg = PRESET_DEFAULTS[preset];

  const submit = async () => {
    if (!parent) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Parse allowlist textarea: one entry per line, current entry-type
      // applied to all. Lets the user paste a list quickly without
      // repeating type labels. Empty → no allowlist (server enforces
      // required-allowlist by preset).
      const allowlist = allowlistText
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => ({ entry_type: allowlistType, entry_value: s }));

      const body: Record<string, unknown> = {
        preset,
        parent_address: parent,
        allowlist,
      };
      if (label.trim()) body.label = label.trim();
      const sp: Record<string, string | null> = {};
      if (overrideMaxPerTx.trim()) sp.max_xrp_per_tx_drops = overrideMaxPerTx.trim();
      if (overrideDaily.trim()) sp.daily_xrp_limit_drops = overrideDaily.trim();
      if (Object.keys(sp).length > 0) body.spend_policy = sp;

      const result = await api<{ id: string; agent_seed: string }>('/v1/agents', {
        method: 'POST',
        body,
      });
      onCreated(result.agent_seed, result.id);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    borderRadius: 4,
    border: '1px solid #cbd5e1',
    fontSize: 13,
    boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    color: '#64748b',
    marginBottom: 4,
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
        <span style={labelStyle}>Preset</span>
        <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
          <label>
            <input
              type="radio"
              name="ntf-preset"
              checked={preset === 'payment-agent'}
              onChange={() => setPreset('payment-agent')}
            />{' '}
            payment-agent
          </label>
          <label>
            <input
              type="radio"
              name="ntf-preset"
              checked={preset === 'treasury-agent'}
              onChange={() => setPreset('treasury-agent')}
            />{' '}
            treasury-agent
          </label>
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{presetCfg?.description}</div>
      </div>

      <div>
        <label style={labelStyle} htmlFor="naf-parent">
          Parent account (must be funded)
        </label>
        {loadingAccounts ? (
          <span style={{ fontSize: 13, color: '#64748b' }}>Loading accounts…</span>
        ) : accountsError ? (
          <span style={{ fontSize: 13, color: '#991b1b' }}>{accountsError}</span>
        ) : accounts.length === 0 ? (
          <span style={{ fontSize: 13, color: '#64748b' }}>
            No managed accounts yet. Create one via <code>POST /v1/accounts</code> first.
          </span>
        ) : (
          <select
            id="naf-parent"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
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

      <div>
        <label style={labelStyle} htmlFor="naf-label">
          Label (optional)
        </label>
        <input
          id="naf-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="invoice-bot"
          maxLength={128}
          style={inputStyle}
        />
      </div>

      <div>
        <span style={labelStyle}>
          Allowlist {presetCfg?.requireAllowlist && <em>(required for this preset)</em>}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <select
            value={allowlistType}
            onChange={(e) => setAllowlistType(e.target.value as 'destination' | 'token' | 'domain')}
            style={{ ...inputStyle, width: 130, flex: 'none' }}
          >
            {presetCfg?.allowedEntryTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <textarea
            value={allowlistText}
            onChange={(e) => setAllowlistText(e.target.value)}
            placeholder={
              allowlistType === 'destination'
                ? 'rDestAddress1...\nrDestAddress2...'
                : allowlistType === 'token'
                  ? '00ABCDEF...  or  USD:rIssuer...'
                  : '64-char hex DomainID'
            }
            rows={3}
            style={{
              ...inputStyle,
              fontFamily: 'monospace',
              resize: 'vertical',
            }}
          />
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
          One entry per line. All lines use the type selected above.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="naf-pertx">
            Max per-tx (drops, optional)
          </label>
          <input
            id="naf-pertx"
            type="text"
            value={overrideMaxPerTx}
            onChange={(e) => setOverrideMaxPerTx(e.target.value)}
            placeholder={`default ${presetCfg?.maxXrpPerTx}`}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="naf-daily">
            Daily cap (drops, optional)
          </label>
          <input
            id="naf-daily"
            type="text"
            value={overrideDaily}
            onChange={(e) => setOverrideDaily(e.target.value)}
            placeholder={`default ${presetCfg?.dailyXrp}`}
            style={inputStyle}
          />
        </div>
      </div>

      {submitError && <div style={{ fontSize: 12, color: '#991b1b' }}>{submitError}</div>}

      <div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !parent}
          style={{
            padding: '8px 16px',
            background: submitting || !parent ? '#cbd5e1' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: submitting || !parent ? 'not-allowed' : 'pointer',
            fontSize: 13,
          }}
        >
          {submitting ? 'Provisioning…' : 'Provision agent'}
        </button>
      </div>
    </div>
  );
}
