import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { Credential, Network } from '../types.ts';

export function Credentials({ network }: { network: Network }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCredentials = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ data: Credential[] }>(
        `/v1/dashboard/credentials?environment=${network}`,
      );
      setCredentials(data.data);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setCredentials([]);
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    void fetchCredentials();
  }, [fetchCredentials]);

  const statusBadge = (status: string) => {
    const colors: Record<string, { bg: string; text: string }> = {
      pending: { bg: '#fef3c7', text: '#92400e' },
      accepted: { bg: '#dcfce7', text: '#166534' },
      revoked: { bg: '#fee2e2', text: '#991b1b' },
      expired: { bg: '#f1f5f9', text: '#475569' },
    };
    const c = colors[status] ?? { bg: '#f1f5f9', text: '#475569' };
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '2px 8px',
          borderRadius: 9999,
          fontSize: 12,
          fontWeight: 500,
          background: c.bg,
          color: c.text,
        }}
      >
        {status}
      </span>
    );
  };

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24 }}>Credentials</h1>

      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
        Showing <strong>{network}</strong> credentials (XLS-70)
      </div>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading...</p>
      ) : credentials.length === 0 ? (
        <p style={{ color: '#64748b' }}>
          No credentials found. Issue credentials via the API to see them here.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>Type</th>
              <th style={{ padding: '8px 12px' }}>Subject</th>
              <th style={{ padding: '8px 12px' }}>Issuer</th>
              <th style={{ padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }}>Expires</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((cred) => (
              <tr key={cred.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 12px' }}>
                  <code style={{ fontSize: 12 }}>{cred.credential_type}</code>
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  <code>{cred.subject_address.slice(0, 10)}...</code>
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  <code>{cred.issuer_address.slice(0, 10)}...</code>
                </td>
                <td style={{ padding: '8px 12px' }}>{statusBadge(cred.status)}</td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  {cred.expires_at ? new Date(cred.expires_at).toLocaleDateString() : '—'}
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  {cred.created_at ? new Date(cred.created_at).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
