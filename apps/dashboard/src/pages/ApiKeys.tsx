import { useCallback, useEffect, useState } from 'react';
import type { ApiKey, Network } from '../types.ts';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

export function ApiKeys({ network }: { network: Network }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeySecret, setNewKeySecret] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/dashboard/keys?environment=${network}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { data: ApiKey[] };
        setKeys(data.data);
      }
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    void fetchKeys();
  }, [fetchKeys]);

  const createKey = async () => {
    const res = await fetch(`${API_BASE}/v1/dashboard/keys`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environment: network }),
    });
    if (res.ok) {
      const data = (await res.json()) as { api_key: string; prefix: string };
      setNewKeySecret(data.api_key);
      void fetchKeys();
    }
  };

  const revokeKey = async (keyId: string) => {
    await fetch(`${API_BASE}/v1/dashboard/keys/${keyId}/revoke`, {
      method: 'POST',
      credentials: 'include',
    });
    void fetchKeys();
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
              <th style={{ padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
              <th style={{ padding: '8px 12px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 12px' }}>
                  <code>{key.prefix}...</code>
                </td>
                <td style={{ padding: '8px 12px' }}>{key.environment}</td>
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
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
