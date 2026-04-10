import { useCallback, useEffect, useState } from 'react';
import type { Network, Transaction } from '../types.ts';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

const STATUS_COLORS: Record<Transaction['status'], { bg: string; color: string }> = {
  queued: { bg: '#e0e7ff', color: '#3730a3' },
  submitted: { bg: '#fef3c7', color: '#92400e' },
  validated: { bg: '#dcfce7', color: '#166534' },
  failed: { bg: '#fee2e2', color: '#991b1b' },
};

export function Transactions({ network }: { network: Network }) {
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTxs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/dashboard/transactions?network=${network}&limit=50`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { data: Transaction[] };
        setTxs(data.data);
      }
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    void fetchTxs();
  }, [fetchTxs]);

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
        <h1 style={{ margin: 0, fontSize: 24 }}>Transactions</h1>
        <button
          type="button"
          onClick={() => void fetchTxs()}
          style={{
            padding: '8px 16px',
            background: '#f1f5f9',
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>

      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
        Showing <strong>{network}</strong> transactions (last 50)
      </div>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading...</p>
      ) : txs.length === 0 ? (
        <p style={{ color: '#64748b' }}>No transactions yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>Type</th>
              <th style={{ padding: '8px 12px' }}>Source</th>
              <th style={{ padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }}>Hash</th>
              <th style={{ padding: '8px 12px' }}>Ledger</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((tx) => {
              const badge = STATUS_COLORS[tx.status];
              return (
                <tr key={tx.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <code style={{ fontSize: 13 }}>{tx.tx_type}</code>
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 13 }}>
                    <code title={tx.source_address}>
                      {tx.source_address.slice(0, 8)}...
                      {tx.source_address.slice(-4)}
                    </code>
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: 9999,
                        fontSize: 12,
                        fontWeight: 500,
                        background: badge.bg,
                        color: badge.color,
                      }}
                    >
                      {tx.status}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 13 }}>
                    {tx.tx_hash ? (
                      <code title={tx.tx_hash}>{tx.tx_hash.slice(0, 8)}...</code>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>-</span>
                    )}
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 13 }}>
                    {tx.ledger_index ?? <span style={{ color: '#94a3b8' }}>-</span>}
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 13 }}>
                    {new Date(tx.created_at).toLocaleString()}
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
