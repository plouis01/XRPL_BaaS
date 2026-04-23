import { Fragment, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { Credential, Network } from '../types.ts';

// XLS-70 credential_type is hex-encoded UTF-8 (up to 64 bytes on-chain).
// Show the decoded ASCII when it round-trips cleanly — otherwise fall back
// to the raw hex. Useful because issuers typically encode things like "KYC"
// or "AccreditedInvestor" which are unreadable as hex.
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

export function Credentials({ network }: { network: Network }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

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
              <th style={{ padding: '8px 12px', width: 28 }} />
              <th style={{ padding: '8px 12px' }}>Type</th>
              <th style={{ padding: '8px 12px' }}>Subject</th>
              <th style={{ padding: '8px 12px' }}>Issuer</th>
              <th style={{ padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }}>Expires</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((cred) => {
              const isOpen = expanded === cred.id;
              const decoded = decodeCredentialType(cred.credential_type);
              return (
                <Fragment key={cred.id}>
                  <tr
                    style={{
                      borderBottom: '1px solid #e2e8f0',
                      cursor: 'pointer',
                    }}
                    onClick={() => setExpanded(isOpen ? null : cred.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpanded(isOpen ? null : cred.id);
                      }
                    }}
                  >
                    <td style={{ padding: '8px 12px', color: '#64748b' }}>{isOpen ? '▾' : '▸'}</td>
                    <td style={{ padding: '8px 12px' }}>
                      {decoded ? (
                        <span style={{ fontSize: 13 }}>{decoded}</span>
                      ) : (
                        <code style={{ fontSize: 12 }}>{cred.credential_type}</code>
                      )}
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
                  {isOpen && (
                    <tr
                      style={{
                        borderBottom: '1px solid #e2e8f0',
                        background: '#f8fafc',
                      }}
                    >
                      <td colSpan={7} style={{ padding: '16px 24px' }}>
                        <CredentialDetail credential={cred} decoded={decoded} />
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

function CredentialDetail({
  credential,
  decoded,
}: {
  credential: Credential;
  decoded: string | null;
}) {
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
      {field('Credential ID', credential.id)}
      {field(
        'Credential type (hex)',
        decoded ? `${credential.credential_type}  (${decoded})` : credential.credential_type,
      )}
      {field('Subject address', credential.subject_address)}
      {field('Issuer address', credential.issuer_address)}
      {field('Ledger index', credential.ledger_index)}
      {field(
        'Accepted at',
        credential.accepted_at ? new Date(credential.accepted_at).toLocaleString() : null,
        false,
      )}
      {field(
        'Expires at',
        credential.expires_at ? new Date(credential.expires_at).toLocaleString() : null,
        false,
      )}
      {field(
        'Created at',
        credential.created_at ? new Date(credential.created_at).toLocaleString() : null,
        false,
      )}
    </div>
  );
}
