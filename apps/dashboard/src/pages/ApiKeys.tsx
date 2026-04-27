import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { AgentSummary, ApiKey, Network } from '../types.ts';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `API error ${err.status}: ${err.body.slice(0, 160)}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export function ApiKeys({ network }: { network: Network }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeySecret, setNewKeySecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Agent binding (Part 2 of the agent launcher follow-up): loading the
  // tenant's agents lets the user mint a key bound to one. Bindable agents
  // are 'pending' or 'active' — the server enforces the same rule on
  // POST so a stale dropdown can't sneak through a revoked binding.
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ data: ApiKey[] }>(`/v1/dashboard/keys?environment=${network}`);
      setKeys(data.data);
    } catch (err) {
      setKeys([]);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [network]);

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api<{ data: AgentSummary[] }>(
        `/v1/dashboard/agents?environment=${network}`,
      );
      setAgents(data.data.filter((a) => a.status === 'active' || a.status === 'pending'));
    } catch {
      // Non-fatal: agent dropdown is optional. Failing to load it should
      // not block key creation; the user can still make a non-bound key.
      setAgents([]);
    }
  }, [network]);

  useEffect(() => {
    void fetchKeys();
    void fetchAgents();
    // Reset selection when the network changes — bindings shouldn't carry
    // stale state across the toggle.
    setSelectedAgentId('');
  }, [fetchKeys, fetchAgents]);

  const createKey = async () => {
    setError(null);
    try {
      const body: Record<string, unknown> = { environment: network };
      if (selectedAgentId) body.agent_id = selectedAgentId;
      const data = await api<{ key: string; prefix: string }>('/v1/dashboard/keys', {
        method: 'POST',
        body,
      });
      setNewKeySecret(data.key);
      // Clear binding after a successful mint so the next click defaults
      // to "no binding" — minting a string of bound keys is unusual.
      setSelectedAgentId('');
      void fetchKeys();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const revokeKey = async (keyId: string) => {
    setError(null);
    try {
      await api<{ revoked: boolean }>(`/v1/dashboard/keys/${keyId}/revoke`, {
        method: 'POST',
      });
    } catch (err) {
      setError(errorMessage(err));
    }
    void fetchKeys();
  };

  // Resolve agent id → "label · preset" for the keys table. Falls back to
  // a truncated id when the agent is filtered out of the active list (e.g.
  // bound key whose agent is now revoked).
  const agentLabel = (id: string | null): string | null => {
    if (!id) return null;
    const a = agents.find((x) => x.id === id);
    if (!a) return `${id.slice(0, 8)}...`;
    return a.label ? `${a.label} · ${a.preset}` : a.preset;
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24 }}>API Keys</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label htmlFor="apikey-agent" style={{ fontSize: 12, color: '#64748b' }}>
            Bind to agent:
          </label>
          <select
            id="apikey-agent"
            value={selectedAgentId}
            onChange={(e) => setSelectedAgentId(e.target.value)}
            style={{
              padding: '6px 8px',
              borderRadius: 4,
              border: '1px solid #cbd5e1',
              fontSize: 13,
              minWidth: 220,
            }}
          >
            <option value="">— none (regular client key) —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label ?? a.id.slice(0, 8)} · {a.preset}
                {a.status === 'pending' ? ' [pending]' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void createKey()}
            style={{
              padding: '8px 16px',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Create Key
          </button>
        </div>
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

      {newKeySecret && (
        <div
          style={{
            padding: 16,
            background: '#fef3c7',
            border: '1px solid #f59e0b',
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <strong>New API Key (copy now — shown only once):</strong>
          <code style={{ display: 'block', marginTop: 8, wordBreak: 'break-all' }}>
            {newKeySecret}
          </code>
          <button
            type="button"
            onClick={() => setNewKeySecret(null)}
            style={{
              marginTop: 8,
              fontSize: 12,
              cursor: 'pointer',
              background: 'none',
              border: 'none',
              color: '#92400e',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
        Showing <strong>{network}</strong> keys
      </div>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading...</p>
      ) : keys.length === 0 ? (
        <p style={{ color: '#64748b' }}>No API keys yet. Create one to get started.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>Prefix</th>
              <th style={{ padding: '8px 12px' }}>Environment</th>
              <th style={{ padding: '8px 12px' }}>Agent</th>
              <th style={{ padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
              <th style={{ padding: '8px 12px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const agentName = agentLabel(key.agent_id);
              return (
                <tr key={key.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <code>{key.prefix}...</code>
                  </td>
                  <td style={{ padding: '8px 12px' }}>{key.environment}</td>
                  <td style={{ padding: '8px 12px', fontSize: 13 }}>
                    {agentName ? (
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: '#dbeafe',
                          color: '#1e40af',
                          fontSize: 12,
                        }}
                      >
                        {agentName}
                      </span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: 9999,
                        fontSize: 12,
                        fontWeight: 500,
                        background: key.is_active ? '#dcfce7' : '#fee2e2',
                        color: key.is_active ? '#166534' : '#991b1b',
                      }}
                    >
                      {key.is_active ? 'Active' : 'Revoked'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 13 }}>
                    {new Date(key.created_at).toLocaleDateString()}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    {key.is_active && (
                      <button
                        type="button"
                        onClick={() => void revokeKey(key.id)}
                        style={{
                          padding: '4px 10px',
                          background: '#fee2e2',
                          color: '#991b1b',
                          border: '1px solid #fca5a5',
                          borderRadius: 4,
                          cursor: 'pointer',
                          fontSize: 12,
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
