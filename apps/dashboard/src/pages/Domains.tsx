import { useCallback, useEffect, useState } from 'react';
import type { Domain, Network } from '../types.ts';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

export function Domains({ network }: { network: Network }) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchDomains = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/dashboard/domains?environment=${network}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { data: Domain[] };
        setDomains(data.data);
      }
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    void fetchDomains();
  }, [fetchDomains]);

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24 }}>Permissioned Domains</h1>

      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
        Showing <strong>{network}</strong> domains (XLS-80)
      </div>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading...</p>
      ) : domains.length === 0 ? (
        <p style={{ color: '#64748b' }}>
          No domains found. Create domains via the API to see them here.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>Domain ID</th>
              <th style={{ padding: '8px 12px' }}>Owner</th>
              <th style={{ padding: '8px 12px' }}>Credentials</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
              <th style={{ padding: '8px 12px' }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((domain) => (
              <tr key={domain.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 12px' }}>
                  <code style={{ fontSize: 12 }}>
                    {domain.domain_id.startsWith('pending-')
                      ? 'pending...'
                      : `${domain.domain_id.slice(0, 12)}...`}
                  </code>
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  <code>{domain.owner_address.slice(0, 10)}...</code>
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  {domain.accepted_credentials.length} accepted
                  {domain.accepted_credentials.length > 0 && (
                    <ul
                      style={{
                        margin: '4px 0 0',
                        padding: '0 0 0 16px',
                        fontSize: 12,
                      }}
                    >
                      {domain.accepted_credentials.map((c, i) => (
                        <li key={`${c.issuer}-${c.credential_type}-${i}`}>
                          <code>{c.credential_type}</code> from{' '}
                          <code>{c.issuer.slice(0, 8)}...</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  {domain.created_at ? new Date(domain.created_at).toLocaleDateString() : '—'}
                </td>
                <td style={{ padding: '8px 12px', fontSize: 13 }}>
                  {domain.updated_at ? new Date(domain.updated_at).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
