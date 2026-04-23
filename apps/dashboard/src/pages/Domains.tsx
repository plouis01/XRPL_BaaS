import { Fragment, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { Domain, Network } from '../types.ts';

export function Domains({ network }: { network: Network }) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchDomains = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ data: Domain[] }>(`/v1/dashboard/domains?environment=${network}`);
      setDomains(data.data);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setDomains([]);
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
              <th style={{ padding: '8px 12px', width: 28 }} />
              <th style={{ padding: '8px 12px' }}>Domain ID</th>
              <th style={{ padding: '8px 12px' }}>Owner</th>
              <th style={{ padding: '8px 12px' }}>Credentials</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
              <th style={{ padding: '8px 12px' }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((domain) => {
              const isOpen = expanded === domain.id;
              const isPending = domain.domain_id.startsWith('pending-');
              return (
                <Fragment key={domain.id}>
                  <tr
                    style={{
                      borderBottom: '1px solid #e2e8f0',
                      cursor: 'pointer',
                    }}
                    onClick={() => setExpanded(isOpen ? null : domain.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpanded(isOpen ? null : domain.id);
                      }
                    }}
                  >
                    <td style={{ padding: '8px 12px', color: '#64748b' }}>{isOpen ? '▾' : '▸'}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <code style={{ fontSize: 12 }}>
                        {isPending ? 'pending...' : `${domain.domain_id.slice(0, 12)}...`}
                      </code>
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 13 }}>
                      <code>{domain.owner_address.slice(0, 10)}...</code>
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 13 }}>
                      {domain.accepted_credentials.length} accepted
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 13 }}>
                      {domain.created_at ? new Date(domain.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 13 }}>
                      {domain.updated_at ? new Date(domain.updated_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr
                      style={{
                        borderBottom: '1px solid #e2e8f0',
                        background: '#f8fafc',
                      }}
                    >
                      <td colSpan={6} style={{ padding: '16px 24px' }}>
                        <DomainDetail domain={domain} />
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

// XLS-70 credential_type is hex-encoded UTF-8 on-chain. Show the decoded
// ASCII when it round-trips cleanly — same heuristic as Credentials page.
function decodeCredentialType(hex: string): string | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      const b = Number.parseInt(hex.slice(i, i + 2), 16);
      if (Number.isNaN(b)) return null;
      bytes[i / 2] = b;
    }
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/^[\x20-\x7E]+$/.test(s)) return s;
    return null;
  } catch {
    return null;
  }
}

function DomainDetail({ domain }: { domain: Domain }) {
  const field = (label: string, value: string | null | undefined, mono = true) => (
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {field('Domain ID', domain.domain_id)}
      {field('Owner address', domain.owner_address)}
      <div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
          Accepted credentials ({domain.accepted_credentials.length})
        </div>
        {domain.accepted_credentials.length === 0 ? (
          <span style={{ fontSize: 12, color: '#94a3b8' }}>—</span>
        ) : (
          <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 13 }}>
            {domain.accepted_credentials.map((c, i) => {
              const decoded = decodeCredentialType(c.credential_type);
              return (
                <li key={`${c.issuer}-${c.credential_type}-${i}`} style={{ marginBottom: 4 }}>
                  {decoded ? (
                    <span>
                      <strong>{decoded}</strong>{' '}
                      <code style={{ fontSize: 11, color: '#64748b' }}>({c.credential_type})</code>
                    </span>
                  ) : (
                    <code style={{ fontSize: 12 }}>{c.credential_type}</code>
                  )}{' '}
                  from <code style={{ fontSize: 12 }}>{c.issuer}</code>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {field(
        'Created at',
        domain.created_at ? new Date(domain.created_at).toLocaleString() : null,
        false,
      )}
      {field(
        'Updated at',
        domain.updated_at ? new Date(domain.updated_at).toLocaleString() : null,
        false,
      )}
    </div>
  );
}
