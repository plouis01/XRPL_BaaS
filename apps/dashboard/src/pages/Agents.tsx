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
import type {
  Account,
  Agent,
  AgentSummary,
  AgentTransaction,
  AgentUsage,
  Network,
} from '../types.ts';

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

function StatusBadge({
  status,
  pendingRevocation,
}: {
  status: string;
  pendingRevocation?: boolean;
}) {
  // While the SignerListSet is in flight, the row's stored status is still
  // 'active' but pending_revocation=true. Surface that as "revoking" so the
  // user sees the in-flight state instead of a stale "active" badge.
  const effective = pendingRevocation && status === 'active' ? 'revoking' : status;
  const palette: Record<string, { bg: string; text: string }> = {
    ...STATUS_COLORS,
    revoking: { bg: '#ffedd5', text: '#9a3412' },
  };
  const c = palette[effective] ?? { bg: '#f1f5f9', text: '#475569' };
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
      {effective}
    </span>
  );
}

function formatTxAmount(drops: string | null): string {
  if (!drops) return '— (non-XRP)';
  const n = Number(drops);
  if (!Number.isFinite(n)) return drops;
  return (n / 1_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

// Well-known IOU tokens, indexed by network. Each entry produces a
// single allowlist token-row in the format the server expects:
// `<currency>:<issuer>` where currency is the 40-char hex form (XRPL's
// canonical encoding for codes longer than 3 chars). RLUSD = "RLUSD"
// → 0x52,0x4C,0x55,0x53,0x44 padded to 20 bytes.
//
// Adding more entries here is the single edit point for the picker —
// both the new-agent form and the post-deploy editor read this list.
interface WellKnownToken {
  /** Display label shown in the dropdown. */
  label: string;
  /** Short note shown next to the label, e.g. "Ripple stablecoin". */
  description: string;
  /** Pre-formatted `<currency-hex>:<issuer-r-address>` allowlist entry. */
  entry: string;
}

const WELL_KNOWN_TOKENS: Record<Network, WellKnownToken[]> = {
  mainnet: [
    {
      label: 'RLUSD',
      description: 'Ripple stablecoin (mainnet)',
      entry: '524C555344000000000000000000000000000000:rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
    },
  ],
  testnet: [
    {
      label: 'RLUSD',
      description: 'Ripple stablecoin (testnet)',
      entry: '524C555344000000000000000000000000000000:rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV',
    },
  ],
};

export function Agents({ network }: { network: Network }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [seedToShowOnce, setSeedToShowOnce] = useState<{
    seed: string;
    agentId: string;
    /**
     * Scope-bound API key auto-minted right after provision so the user
     * doesn't have to bounce through /keys for the common path. Optional:
     * if the auto-mint call fails (network blip, race against agent
     * status), the banner falls back to a "mint on API Keys" hint.
     */
    apiKey?: string;
    apiKeyError?: string;
  } | null>(null);
  // Revoked agents are kept in the system for audit but cluttering the
  // active-management view doesn't help anyone. Hidden by default; the
  // toggle exposes them when the user actually wants to inspect history.
  const [showRevoked, setShowRevoked] = useState(false);

  // `silent` is the background-poll branch: don't flip the spinner and
  // don't wipe the table on a transient error. The user-initiated path
  // (mount, network change, post-create) keeps the loud behavior so they
  // get visible feedback that the page is loading.
  const fetchAgents = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const data = await api<{ data: AgentSummary[] }>(
          `/v1/dashboard/agents?environment=${network}`,
        );
        setAgents(data.data);
        if (silent) setError(null);
      } catch (err) {
        if (!silent) {
          setAgents([]);
          setError(errorMessage(err));
        }
        // Silent path swallows the error — the next tick of the background
        // poll will retry, and a transient blip shouldn't blank the table
        // the user is looking at.
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [network],
  );

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  // List-level background poll. The per-row AgentDetail polls /v1/agents/:id
  // and triggers a list refresh on a status flip — but it only mounts when
  // the user expands a row. Fresh agents land in the table collapsed, so
  // without this hook the badge sits at "pending" until manual refresh.
  // Poll the list while any row is in flight (pending grant or pending
  // revocation) and stop once everything has reached a terminal state.
  //
  // Cadence: 10 s. xrpld closes ledgers every ~4 s and a SignerListSet
  // typically validates within 5–10 s, so 10 s gives near-realtime feedback
  // without hammering Redis on every dashboard tab. Previously 3 s — each
  // poll runs 4–6 Redis ops through the API (rate limit, idempotency cache,
  // revocation, etc.) and a single open tab burned ~7K ops/hour on this
  // hook alone. 10 s is ~3× cheaper and still under the typical settle
  // time, so a refresh almost always lands on a terminal state.
  const anyInFlight = agents.some(
    (a) => a.status === 'pending' || a.status === 'submitting' || a.pending_revocation === true,
  );
  useEffect(() => {
    if (!anyInFlight) return;
    const interval = setInterval(() => {
      void fetchAgents({ silent: true });
    }, 10_000);
    return () => clearInterval(interval);
  }, [anyInFlight, fetchAgents]);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label
            style={{
              fontSize: 12,
              color: '#64748b',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={showRevoked}
              onChange={(e) => setShowRevoked(e.target.checked)}
            />
            Show revoked
          </label>
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
      </div>

      {showCreate && (
        <NewAgentForm
          network={network}
          onCreated={(seed, agentId) => {
            setShowCreate(false);
            // Show the seed banner immediately, then auto-mint a scope-
            // bound API key in the background and patch it into the
            // banner state when it lands. We deliberately don't block the
            // banner on the mint — the seed is the irrecoverable secret;
            // the key can always be minted later on /keys if this fails.
            setSeedToShowOnce({ seed, agentId });
            void fetchAgents();
            void (async () => {
              try {
                const minted = await api<{ key: string }>('/v1/dashboard/keys', {
                  method: 'POST',
                  body: { environment: network, agent_id: agentId },
                });
                setSeedToShowOnce((prev) =>
                  prev && prev.agentId === agentId ? { ...prev, apiKey: minted.key } : prev,
                );
              } catch (err) {
                setSeedToShowOnce((prev) =>
                  prev && prev.agentId === agentId
                    ? { ...prev, apiKeyError: errorMessage(err) }
                    : prev,
                );
              }
            })();
          }}
        />
      )}

      {seedToShowOnce && (
        <SeedOnceBanner
          seed={seedToShowOnce.seed}
          agentId={seedToShowOnce.agentId}
          apiKey={seedToShowOnce.apiKey}
          apiKeyError={seedToShowOnce.apiKeyError}
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

      {(() => {
        const visibleAgents = showRevoked ? agents : agents.filter((a) => a.status !== 'revoked');
        const hiddenCount = agents.length - visibleAgents.length;
        return loading ? (
          <p style={{ color: '#64748b' }}>Loading...</p>
        ) : agents.length === 0 ? (
          <p style={{ color: '#64748b' }}>
            No agents yet. Provision one with <code>POST /v1/agents</code> or the button above.
          </p>
        ) : visibleAgents.length === 0 ? (
          <p style={{ color: '#64748b' }}>
            All {agents.length} agent(s) are revoked. Toggle <em>Show revoked</em> to inspect.
          </p>
        ) : (
          <>
            {hiddenCount > 0 && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
                {hiddenCount} revoked agent(s) hidden
              </div>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr
                  style={{
                    borderBottom: '2px solid #e2e8f0',
                    textAlign: 'left',
                  }}
                >
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
                {visibleAgents.map((a) => {
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
                        <td style={{ padding: '8px 12px', color: '#64748b' }}>
                          {isOpen ? '▾' : '▸'}
                        </td>
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
                          <StatusBadge status={a.status} pendingRevocation={a.pending_revocation} />
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
                            <AgentDetail
                              agentId={a.id}
                              network={network}
                              onStatusFlip={() => void fetchAgents()}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </>
        );
      })()}
    </div>
  );
}

function AgentDetail({
  agentId,
  network,
  onStatusFlip,
}: {
  agentId: string;
  /** Threaded down to AllowlistEditor → AllowlistTypeInput for the
   *  well-known-token picker (RLUSD issuer differs by network). */
  network: Network;
  onStatusFlip: () => void;
}) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tracks the last status we surfaced to the parent — when the agent flips
  // pending → active mid-poll, we trigger a single list refresh so the
  // table badge updates without a full page reload. Same fires for the
  // active → revoked terminal flip after a DELETE /v1/agents/:id.
  const [lastStatus, setLastStatus] = useState<string | null>(null);

  // Revocation flow state.
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Allowlist editor state. `editing` non-null = inline editor is open with
  // a working copy of the per-type buckets; null = read-only view.
  const [editing, setEditing] = useState<Record<'destination' | 'token' | 'domain', string> | null>(
    null,
  );
  const [savingAllowlist, setSavingAllowlist] = useState(false);
  const [allowlistError, setAllowlistError] = useState<string | null>(null);

  // Per-agent tx history. Loaded once when the row expands and refreshed
  // alongside the detail poll so a freshly-validated tx surfaces without
  // a manual reload.
  const [txHistory, setTxHistory] = useState<AgentTransaction[] | null>(null);
  const [txHistoryError, setTxHistoryError] = useState<string | null>(null);

  const fetchTxHistory = useCallback(async () => {
    try {
      const data = await api<{ data: AgentTransaction[] }>(
        `/v1/dashboard/agents/${agentId}/transactions?limit=50`,
      );
      setTxHistory(data.data);
      setTxHistoryError(null);
    } catch (err) {
      setTxHistoryError(errorMessage(err));
    }
  }, [agentId]);

  useEffect(() => {
    void fetchTxHistory();
  }, [fetchTxHistory]);

  // Daily XRP spend usage vs caps. Polls slowly while the row is open so
  // the meter updates after a payment validates without a full reload.
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    try {
      const data = await api<AgentUsage>(`/v1/dashboard/agents/${agentId}/usage`);
      setUsage(data);
      setUsageError(null);
    } catch (err) {
      setUsageError(errorMessage(err));
    }
  }, [agentId]);

  useEffect(() => {
    void fetchUsage();
    // 10 s cadence: fast enough to feel live after a tx clears, slow enough
    // not to hammer the Redis counter when the panel sits open idle.
    const interval = setInterval(() => {
      void fetchUsage();
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchUsage]);

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

  // Light poll while the agent has an in-flight on-ledger transition:
  //   - status='pending' → SignerListSet for grant is validating
  //   - pending_revocation=true → SignerListSet for revoke is validating
  // Stop polling once both reach a terminal state.
  //
  // Cadence: 10 s. Was 4 s — the user only sees this view when they've
  // expanded a row, but a SignerListSet validates in 5–10 s anyway, so
  // sub-10 s polling mostly just burns Redis ops on no-change replies.
  useEffect(() => {
    if (!agent) return;
    const inFlight =
      agent.status === 'pending' ||
      agent.status === 'submitting' ||
      agent.pending_revocation === true;
    if (!inFlight) return;
    const t = setInterval(() => {
      void fetchDetail();
    }, 10_000);
    return () => clearInterval(t);
  }, [agent, fetchDetail]);

  const startEditing = () => {
    if (!agent) return;
    const buckets: Record<'destination' | 'token' | 'domain', string[]> = {
      destination: [],
      token: [],
      domain: [],
    };
    for (const e of agent.allowlist ?? []) {
      buckets[e.entry_type].push(e.entry_value);
    }
    setEditing({
      destination: buckets.destination.join('\n'),
      token: buckets.token.join('\n'),
      domain: buckets.domain.join('\n'),
    });
    setAllowlistError(null);
  };

  const saveAllowlist = async () => {
    if (!agent || !editing) return;
    setSavingAllowlist(true);
    setAllowlistError(null);
    try {
      const presetCfg = PRESET_DEFAULTS[agent.preset];
      const allowed = presetCfg?.allowedEntryTypes ?? ['destination', 'token', 'domain'];
      const allowlist = allowed.flatMap((type) =>
        editing[type]
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => ({ entry_type: type, entry_value: s })),
      );
      const updated = await api<Agent>(`/v1/agents/${agent.id}/allowlist`, {
        method: 'PUT',
        body: { allowlist },
      });
      setAgent(updated);
      setEditing(null);
    } catch (err) {
      setAllowlistError(errorMessage(err));
    } finally {
      setSavingAllowlist(false);
    }
  };

  const handleRevoke = async () => {
    if (!agent) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await api<{ tx_id: string; status: string }>(`/v1/agents/${agent.id}`, {
        method: 'DELETE',
      });
      setConfirmingRevoke(false);
      // Refresh detail so pending_revocation flips immediately and the
      // poll effect above kicks in for the on-ledger flip. Also nudge
      // the parent list so the badge updates without waiting.
      await fetchDetail();
      onStatusFlip();
    } catch (err) {
      setRevokeError(errorMessage(err));
    } finally {
      setRevoking(false);
    }
  };

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
      <SpendUsagePanel
        agentId={agent.id}
        usage={usage}
        error={usageError}
        // Fall back to the policy snapshot the agent detail returned so the
        // panel renders immediately on open, even before /usage resolves.
        fallbackPolicy={agent.spend_policy ?? null}
        // Same gate as the allowlist editor — only meaningful while the
        // agent can still spend. Revoked / pending-revocation rows are
        // read-only.
        canEdit={agent.status === 'active' && !agent.pending_revocation}
        onSaved={() => {
          // Refresh both the usage panel (new caps) and the agent detail
          // (so spend_policy on the response shape stays consistent).
          void fetchUsage();
          void fetchDetail();
        }}
      />
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 4,
          }}
        >
          <div style={{ fontSize: 12, color: '#64748b' }}>
            Allowlist ({agent.allowlist?.length ?? 0})
          </div>
          {/* Edit only meaningful while the agent can still spend. Revoked /
              pending-revocation agents are read-only. */}
          {editing === null && agent.status === 'active' && !agent.pending_revocation && (
            <button
              type="button"
              onClick={startEditing}
              style={{
                padding: '2px 10px',
                background: 'transparent',
                color: '#2563eb',
                border: '1px solid #2563eb',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Edit
            </button>
          )}
        </div>
        {editing !== null ? (
          <AllowlistEditor
            preset={agent.preset}
            buckets={editing}
            onChange={setEditing}
            onSave={() => void saveAllowlist()}
            onCancel={() => {
              setEditing(null);
              setAllowlistError(null);
            }}
            saving={savingAllowlist}
            error={allowlistError}
            network={network}
          />
        ) : !agent.allowlist || agent.allowlist.length === 0 ? (
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

      <AgentTxHistory
        rows={txHistory}
        error={txHistoryError}
        onRefresh={() => void fetchTxHistory()}
      />

      {/* Revoke action — only meaningful while status='active' and no
          revocation is already in flight. The server enforces these same
          conditions; the gate here keeps the UI clean. */}
      {agent.status === 'active' && (
        <div
          style={{
            borderTop: '1px solid #e2e8f0',
            paddingTop: 12,
            marginTop: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {agent.pending_revocation ? (
            <div style={{ fontSize: 12, color: '#9a3412' }}>
              Revocation queued, waiting for on-ledger SignerListSet to validate. The status badge
              will flip to <code>revoked</code> once it does.
            </div>
          ) : !confirmingRevoke ? (
            <div>
              <button
                type="button"
                onClick={() => setConfirmingRevoke(true)}
                style={{
                  padding: '6px 12px',
                  background: '#fee2e2',
                  color: '#991b1b',
                  border: '1px solid #fca5a5',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                Revoke agent
              </button>
            </div>
          ) : (
            <div
              style={{
                padding: 12,
                background: '#fef2f2',
                border: '1px solid #fca5a5',
                borderRadius: 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 13, color: '#991b1b' }}>
                Revoke this agent? RailForge will queue a SignerListSet that strips the delegate's
                signing authority on the parent account. The agent will be permanently revoked once
                the tx validates.
              </div>
              {revokeError && <div style={{ fontSize: 12, color: '#991b1b' }}>{revokeError}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => void handleRevoke()}
                  disabled={revoking}
                  style={{
                    padding: '6px 12px',
                    background: revoking ? '#cbd5e1' : '#dc2626',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 4,
                    cursor: revoking ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                  }}
                >
                  {revoking ? 'Revoking…' : 'Yes, revoke'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingRevoke(false);
                    setRevokeError(null);
                  }}
                  disabled={revoking}
                  style={{
                    padding: '6px 12px',
                    background: 'transparent',
                    color: '#475569',
                    border: '1px solid #cbd5e1',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
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

// Banner shown immediately after a successful POST /v1/agents. Surfaces
// two one-shot secrets:
//
//   1. The scope-bound API key, auto-minted right after provision. This
//      is what most users actually paste into their agent code — the
//      common path doesn't require ever touching the seed.
//   2. The XRPL delegate seed, returned by /v1/agents itself. Optional:
//      only needed for non-custodial signing flows. Power users keep it.
//
// Dismissing clears both from React state so a hot reload or back-nav
// doesn't leak them. There is no recovery path for the seed; the API
// key can be re-minted from the API Keys page if lost.
function SeedOnceBanner({
  seed,
  agentId,
  apiKey,
  apiKeyError,
  onDismiss,
}: {
  seed: string;
  agentId: string;
  apiKey?: string;
  apiKeyError?: string;
  onDismiss: () => void;
}) {
  const [seedCopied, setSeedCopied] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const copy = async (text: string, setter: (v: boolean) => void): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setter(true);
      setTimeout(() => setter(false), 1500);
    } catch {
      // clipboard API can fail in non-secure contexts; user can still
      // select the text manually.
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
      <div style={{ fontWeight: 600, marginBottom: 4, color: '#92400e' }}>
        Agent provisioned. Copy the secrets below, shown only once.
      </div>
      <div style={{ fontSize: 12, color: '#92400e', marginBottom: 12 }}>
        Agent <code>{agentId}</code>.
      </div>

      {/* API key — primary block. Most users only need this. */}
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            fontSize: 12,
            color: '#92400e',
            marginBottom: 4,
            fontWeight: 600,
          }}
        >
          Scope-bound API key, paste into your agent's environment
        </div>
        {apiKey ? (
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
            <span style={{ flex: 1 }}>{apiKey}</span>
            <button
              type="button"
              onClick={() => void copy(apiKey, setKeyCopied)}
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
              {keyCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        ) : apiKeyError ? (
          <div style={{ fontSize: 12, color: '#92400e' }}>
            Auto-mint failed: {apiKeyError}. You can mint one manually on the API Keys page (pick
            this agent in the Bind-to-agent dropdown).
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#92400e', fontStyle: 'italic' }}>Minting key…</div>
        )}
      </div>

      {/* Seed — secondary block. Only relevant for non-custodial signing. */}
      <details style={{ marginBottom: 12 }}>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 12,
            color: '#92400e',
            fontWeight: 600,
          }}
        >
          XRPL delegate seed (advanced: non-custodial signing)
        </summary>
        <div style={{ fontSize: 11, color: '#92400e', margin: '6px 0' }}>
          Only needed if you'll sign agent transactions yourself rather than through RailForge. Save
          it in a password manager, there's no recovery path.
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
            onClick={() => void copy(seed, setSeedCopied)}
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
            {seedCopied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </details>

      <button
        type="button"
        onClick={onDismiss}
        style={{
          padding: '4px 12px',
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
  );
}

const PRESET_DEFAULTS: Record<
  string,
  {
    description: string;
    requireAllowlist: boolean;
    allowedEntryTypes: Array<'destination' | 'token' | 'domain'>;
    /** Default per-tx cap shown in the new-agent form, in dollars. */
    maxPerTxUsd: string;
    /** Default daily cap shown in the new-agent form, in dollars. */
    dailyUsd: string;
  }
> = {
  'payment-agent': {
    description: 'Pay allowlisted destinations. $10/tx, $100/day default.',
    requireAllowlist: true,
    allowedEntryTypes: ['destination', 'token'],
    maxPerTxUsd: '10',
    dailyUsd: '100',
  },
  'treasury-agent': {
    description:
      'Disburse to destinations or XLS-80 domain members. $1,000/tx, $10,000/day defaults.',
    requireAllowlist: false,
    allowedEntryTypes: ['destination', 'token', 'domain'],
    maxPerTxUsd: '1000',
    dailyUsd: '10000',
  },
};

const ALLOWLIST_TYPE_META: Record<
  'destination' | 'token' | 'domain',
  { label: string; placeholder: string }
> = {
  destination: {
    label: 'Destinations (r-addresses)',
    placeholder: 'rDestAddress1...\nrDestAddress2...',
  },
  token: {
    label: 'Tokens (MPT id or CUR:issuer)',
    placeholder: '00ABCDEF...\nUSD:rIssuer...',
  },
  domain: {
    label: 'XLS-80 domains (64-char hex DomainID)',
    placeholder: 'ABCD...64hex',
  },
};

function AllowlistTypeInput({
  type,
  value,
  onChange,
  inputStyle,
  network,
}: {
  type: 'destination' | 'token' | 'domain';
  value: string;
  onChange: (v: string) => void;
  inputStyle: React.CSSProperties;
  /**
   * When provided AND type === 'token', a "well-known token" picker
   * appears next to the label. Selecting an entry appends the canonical
   * `<currency-hex>:<issuer>` form to the textarea (skipping if already
   * present). Network determines which issuer address is used (mainnet
   * vs testnet RLUSD live at different r-addresses).
   */
  network?: Network;
}) {
  const meta = ALLOWLIST_TYPE_META[type];
  const knownTokens = network && type === 'token' ? WELL_KNOWN_TOKENS[network] : null;

  const addEntry = (entry: string) => {
    // Skip the append if the same entry already exists in the textarea —
    // server would reject the duplicate via the (agent_id, entry_type,
    // entry_value) UNIQUE constraint, but catching it here keeps the
    // textarea tidy and avoids a confusing 409 on save.
    const existing = value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (existing.includes(entry)) return;
    const next = [...existing, entry].join('\n');
    onChange(next);
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 4,
        }}
      >
        <div style={{ fontSize: 12, color: '#475569' }}>{meta.label}</div>
        {knownTokens && knownTokens.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) addEntry(e.target.value);
              // Reset so re-selecting the same option fires onChange again.
              e.target.value = '';
            }}
            style={{
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 4,
              border: '1px solid #cbd5e1',
              cursor: 'pointer',
            }}
          >
            <option value="">+ Well-known token…</option>
            {knownTokens.map((t) => (
              <option key={t.entry} value={t.entry}>
                {t.label} — {t.description}
              </option>
            ))}
          </select>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={meta.placeholder}
        rows={3}
        style={{
          ...inputStyle,
          fontFamily: 'monospace',
          resize: 'vertical',
        }}
      />
    </div>
  );
}

function AllowlistEditor({
  preset,
  buckets,
  onChange,
  onSave,
  onCancel,
  saving,
  error,
  network,
}: {
  preset: string;
  buckets: Record<'destination' | 'token' | 'domain', string>;
  onChange: (b: Record<'destination' | 'token' | 'domain', string>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  /** Drives the well-known-token picker on the token textarea. */
  network: Network;
}) {
  // Falls back to all three types when the preset is unknown — the server
  // is the source of truth on what's accepted, so we don't want to
  // pre-filter so aggressively that an unrecognized preset can't be edited.
  const allowed = PRESET_DEFAULTS[preset]?.allowedEntryTypes ?? ['destination', 'token', 'domain'];
  const editorInputStyle: React.CSSProperties = {
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
        padding: 12,
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {allowed.map((type) => (
        <AllowlistTypeInput
          key={type}
          type={type}
          value={buckets[type]}
          onChange={(v) => onChange({ ...buckets, [type]: v })}
          inputStyle={editorInputStyle}
          network={network}
        />
      ))}
      <div style={{ fontSize: 11, color: '#94a3b8' }}>
        One entry per line. Saving replaces the entire allowlist (pure DB, no on-ledger
        transaction).
      </div>
      {error && <div style={{ fontSize: 12, color: '#991b1b' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          style={{
            padding: '6px 14px',
            background: saving ? '#cbd5e1' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontSize: 12,
          }}
        >
          {saving ? 'Saving…' : 'Save allowlist'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            padding: '6px 14px',
            background: 'transparent',
            color: '#475569',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontSize: 12,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SpendUsagePanel({
  agentId,
  usage,
  error,
  fallbackPolicy,
  canEdit,
  onSaved,
}: {
  agentId: string;
  usage: AgentUsage | null;
  error: string | null;
  fallbackPolicy: {
    max_per_tx_usd_cents: string | null;
    daily_limit_usd_cents: string | null;
  } | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  // Prefer live usage payload; fall back to the agent's policy snapshot
  // until /usage resolves so the caps don't flash empty on first render.
  const dailyLimit = usage?.daily_limit_usd_cents ?? fallbackPolicy?.daily_limit_usd_cents ?? null;
  const maxPerTx = usage?.max_per_tx_usd_cents ?? fallbackPolicy?.max_per_tx_usd_cents ?? null;
  const usedCents = usage?.daily_used_usd_cents ?? null;

  const usedNum = usedCents ? Number(usedCents) : 0;
  const limitNum = dailyLimit ? Number(dailyLimit) : null;
  const pct =
    limitNum && limitNum > 0 ? Math.min(100, Math.round((usedNum / limitNum) * 100)) : null;
  const barColor =
    pct === null ? '#cbd5e1' : pct < 70 ? '#16a34a' : pct < 95 ? '#d97706' : '#dc2626';

  const [editing, setEditing] = useState(false);
  // Inputs are USD (dollars). Empty → cap removed (null on the wire).
  // The save handler converts dollars to cents.
  const [perTxUsd, setPerTxUsd] = useState('');
  const [dailyUsd, setDailyUsd] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const startEditing = () => {
    setPerTxUsd(maxPerTx ? centsToDollarString(maxPerTx) : '');
    setDailyUsd(dailyLimit ? centsToDollarString(dailyLimit) : '');
    setSaveError(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, string | null> = {};
      const perTxRaw = perTxUsd.trim();
      const dailyRaw = dailyUsd.trim();
      if (perTxRaw === '') {
        body.max_per_tx_usd_cents = null;
      } else {
        const cents = usdToCents(perTxRaw);
        if (cents === null) throw new Error('Per-tx must be a non-negative dollar amount');
        body.max_per_tx_usd_cents = cents;
      }
      if (dailyRaw === '') {
        body.daily_limit_usd_cents = null;
      } else {
        const cents = usdToCents(dailyRaw);
        if (cents === null) throw new Error('Daily must be a non-negative dollar amount');
        body.daily_limit_usd_cents = cents;
      }
      await api(`/v1/agents/${agentId}/spend-policy`, { method: 'PUT', body });
      setEditing(false);
      onSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 4,
        }}
      >
        <div style={{ fontSize: 12, color: '#64748b' }}>
          Spend caps (USD)
          {usage?.scope === 'client' && ' — inherited from tenant'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {usage?.scope === 'client' && (
            <span style={{ fontSize: 10, color: '#94a3b8' }}>shared by all inheriting agents</span>
          )}
          {!editing && canEdit && (
            <button
              type="button"
              onClick={startEditing}
              style={{
                padding: '2px 10px',
                background: 'transparent',
                color: '#2563eb',
                border: '1px solid #2563eb',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Edit
            </button>
          )}
        </div>
      </div>
      {error && <div style={{ fontSize: 11, color: '#991b1b', marginBottom: 4 }}>{error}</div>}

      {editing ? (
        <SpendCapEditor
          perTxUsd={perTxUsd}
          dailyUsd={dailyUsd}
          onPerTxChange={setPerTxUsd}
          onDailyChange={setDailyUsd}
          saving={saving}
          error={saveError}
          onSave={() => void save()}
          onCancel={() => {
            setEditing(false);
            setSaveError(null);
          }}
        />
      ) : (
        <>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            Per-tx: <strong>{formatCents(maxPerTx)}</strong>
            {'  ·  '}
            Daily limit: <strong>{formatCents(dailyLimit)}</strong>
          </div>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>
            Used today: <strong>{usedCents ? formatCentsValue(usedCents) : '—'}</strong>
            {pct !== null && <span style={{ marginLeft: 6 }}>({pct}%)</span>}
          </div>
          {pct !== null && (
            <div
              style={{
                height: 6,
                background: '#e2e8f0',
                borderRadius: 9999,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: barColor,
                  transition: 'width 200ms ease',
                }}
              />
            </div>
          )}
          {usage?.xrp_usd_rate && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
              XRP txs converted at {formatCentsValue(String(usage.xrp_usd_rate.cents))}/XRP
              {' — '}
              {usage.xrp_usd_rate.source === 'coingecko'
                ? `CoinGecko, ${ageOf(usage.xrp_usd_rate.fetched_at)}`
                : 'fallback rate (price feed unavailable)'}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Convert a user-typed dollar string (e.g. "12.34") to integer cents.
// Returns null on non-numeric / negative input. String-math preserves
// precision for caps that would round badly through Number.
function usdToCents(input: string): string | null {
  if (!/^\d+(\.\d+)?$/.test(input)) return null;
  const [whole, frac = ''] = input.split('.');
  // Truncate beyond 2 decimals — sub-cent precision isn't meaningful for
  // caps, and storing it would just confuse the UI on re-edit.
  const padded = `${frac}00`.slice(0, 2);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  return combined;
}

// Format an integer cents string as `$X.XX` (or `no cap` for null).
function formatCents(cents: string | null): string {
  if (!cents) return 'no cap';
  return formatCentsValue(cents);
}

// Format an integer cents string as `$X.XX`. Used for both caps and
// usage; `formatCents` adds the "no cap" sentinel for the null case.
function centsToDollarString(cents: string): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return cents;
  return (n / 100).toFixed(2);
}

function formatCentsValue(cents: string): string {
  return `$${centsToDollarString(cents)}`;
}

// "5 minutes ago" / "just now" — short hint for the price feed age line.
function ageOf(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown age';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 30) return 'just now';
  if (sec < 90) return '~1 min ago';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function SpendCapEditor({
  perTxUsd,
  dailyUsd,
  onPerTxChange,
  onDailyChange,
  saving,
  error,
  onSave,
  onCancel,
}: {
  perTxUsd: string;
  dailyUsd: string;
  onPerTxChange: (v: string) => void;
  onDailyChange: (v: string) => void;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
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
    fontSize: 11,
    color: '#64748b',
    marginBottom: 2,
  };
  return (
    <div
      style={{
        border: '1px solid #cbd5e1',
        borderRadius: 6,
        padding: 12,
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="sp-pertx">
            Per-tx (USD)
          </label>
          <input
            id="sp-pertx"
            type="text"
            value={perTxUsd}
            onChange={(e) => onPerTxChange(e.target.value)}
            placeholder="e.g. 50.00  (blank to remove cap)"
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="sp-daily">
            Daily limit (USD)
          </label>
          <input
            id="sp-daily"
            type="text"
            value={dailyUsd}
            onChange={(e) => onDailyChange(e.target.value)}
            placeholder="e.g. 500.00  (blank to remove cap)"
            style={inputStyle}
          />
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8' }}>
        Caps are USD-denominated. XRP txs convert via the live CoinGecko rate (60s cache); RLUSD =
        $1 (no oracle round-trip). Changes apply immediately, lowering the daily cap below today's
        already-spent amount locks the client out until the 24h window rolls over.
      </div>
      {error && <div style={{ fontSize: 12, color: '#991b1b' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          style={{
            padding: '6px 14px',
            background: saving ? '#cbd5e1' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontSize: 12,
          }}
        >
          {saving ? 'Saving…' : 'Save caps'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            padding: '6px 14px',
            background: 'transparent',
            color: '#475569',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontSize: 12,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function AgentTxHistory({
  rows,
  error,
  onRefresh,
}: {
  rows: AgentTransaction[] | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const headerStyle: React.CSSProperties = {
    padding: '6px 8px',
    fontSize: 11,
    color: '#64748b',
    textAlign: 'left',
    borderBottom: '1px solid #e2e8f0',
  };
  const cellStyle: React.CSSProperties = {
    padding: '6px 8px',
    fontSize: 12,
  };
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 4,
        }}
      >
        <div style={{ fontSize: 12, color: '#64748b' }}>
          Transaction history ({rows?.length ?? 0})
        </div>
        <button
          type="button"
          onClick={onRefresh}
          style={{
            padding: '2px 10px',
            background: 'transparent',
            color: '#475569',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          Refresh
        </button>
      </div>
      {error ? (
        <span style={{ fontSize: 12, color: '#991b1b' }}>{error}</span>
      ) : rows === null ? (
        <span style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</span>
      ) : rows.length === 0 ? (
        <span style={{ fontSize: 12, color: '#94a3b8' }}>
          No transactions yet, this agent hasn't submitted any payments.
        </span>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headerStyle}>When</th>
              <th style={headerStyle}>Type</th>
              <th style={headerStyle}>Status</th>
              <th style={headerStyle}>Amount (XRP)</th>
              <th style={headerStyle}>Tx hash</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((tx) => (
              <tr key={tx.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={cellStyle}>
                  {tx.created_at ? new Date(tx.created_at).toLocaleString() : '—'}
                </td>
                <td style={cellStyle}>{tx.tx_type}</td>
                <td style={cellStyle}>
                  <TxStatusBadge status={tx.status} />
                  {tx.result_code && tx.result_code !== 'tesSUCCESS' && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        color: '#991b1b',
                      }}
                    >
                      {tx.result_code}
                    </span>
                  )}
                </td>
                <td style={cellStyle}>{formatTxAmount(tx.amount_drops)}</td>
                <td style={{ ...cellStyle, fontFamily: 'monospace' }}>
                  {tx.tx_hash ? (
                    <code style={{ fontSize: 11, wordBreak: 'break-all' }}>
                      {tx.tx_hash.slice(0, 12)}…
                    </code>
                  ) : (
                    <span style={{ color: '#94a3b8' }}>—</span>
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

function TxStatusBadge({ status }: { status: string }) {
  const palette: Record<string, { bg: string; text: string }> = {
    queued: { bg: '#fef3c7', text: '#92400e' },
    submitting: { bg: '#fef3c7', text: '#92400e' },
    submitted: { bg: '#fef3c7', text: '#92400e' },
    validated: { bg: '#dcfce7', text: '#166534' },
    failed: { bg: '#fee2e2', text: '#991b1b' },
  };
  const c = palette[status] ?? { bg: '#f1f5f9', text: '#475569' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 9999,
        fontSize: 10,
        fontWeight: 500,
        background: c.bg,
        color: c.text,
      }}
    >
      {status}
    </span>
  );
}

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
  // One textarea per entry type so a single provision can mix destinations,
  // tokens, and (for treasury-agent) XLS-80 domains. Server flattens them
  // back into a single allowlist array on the wire.
  const [allowlistByType, setAllowlistByType] = useState<
    Record<'destination' | 'token' | 'domain', string>
  >({ destination: '', token: '', domain: '' });
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
      // Flatten the per-type textareas into a single allowlist array.
      // One entry per line, blank lines dropped. Empty across all types →
      // no allowlist (server rejects on required-allowlist presets).
      const allowlist = (presetCfg?.allowedEntryTypes ?? []).flatMap((type) =>
        allowlistByType[type]
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => ({ entry_type: type, entry_value: s })),
      );

      const body: Record<string, unknown> = {
        preset,
        parent_address: parent,
        allowlist,
      };
      if (label.trim()) body.label = label.trim();
      const sp: Record<string, string | null> = {};
      // Inputs are USD (dollars). Convert to cents for the wire format
      // the server uses. Reject malformed input early so the user gets a
      // clear inline error instead of a 400 from the API.
      if (overrideMaxPerTx.trim()) {
        const cents = usdToCents(overrideMaxPerTx.trim());
        if (cents === null) throw new Error('Per-tx must be a non-negative dollar amount');
        sp.max_per_tx_usd_cents = cents;
      }
      if (overrideDaily.trim()) {
        const cents = usdToCents(overrideDaily.trim());
        if (cents === null) throw new Error('Daily must be a non-negative dollar amount');
        sp.daily_limit_usd_cents = cents;
      }
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {presetCfg?.allowedEntryTypes.map((type) => (
            <AllowlistTypeInput
              key={type}
              type={type}
              value={allowlistByType[type]}
              onChange={(v) => setAllowlistByType((prev) => ({ ...prev, [type]: v }))}
              inputStyle={inputStyle}
              network={network}
            />
          ))}
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
          One entry per line. Leave a section blank to skip that type.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="naf-pertx">
            Max per-tx (USD, optional)
          </label>
          <input
            id="naf-pertx"
            type="text"
            value={overrideMaxPerTx}
            onChange={(e) => setOverrideMaxPerTx(e.target.value)}
            placeholder={`default $${presetCfg?.maxPerTxUsd}`}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="naf-daily">
            Daily cap (USD, optional)
          </label>
          <input
            id="naf-daily"
            type="text"
            value={overrideDaily}
            onChange={(e) => setOverrideDaily(e.target.value)}
            placeholder={`default $${presetCfg?.dailyUsd}`}
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
