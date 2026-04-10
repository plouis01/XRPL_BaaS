import { useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ApiKeys } from './pages/ApiKeys.tsx';
import { Transactions } from './pages/Transactions.tsx';
import type { Network } from './types.ts';

export function App() {
  const [network, setNetwork] = useState<Network>('testnet');

  return (
    <BrowserRouter>
      <div
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
        }}
      >
        <nav
          style={{
            width: 220,
            padding: '24px 16px',
            borderRight: '1px solid #e2e8f0',
            background: '#f8fafc',
          }}
        >
          <h2 style={{ margin: '0 0 24px', fontSize: 18 }}>RailForge</h2>

          <div style={{ marginBottom: 24 }}>
            <label
              htmlFor="network-select"
              style={{
                fontSize: 12,
                color: '#64748b',
                display: 'block',
                marginBottom: 4,
              }}
            >
              Network
            </label>
            <select
              id="network-select"
              value={network}
              onChange={(e) => setNetwork(e.target.value as Network)}
              style={{
                width: '100%',
                padding: '6px 8px',
                borderRadius: 4,
                border: '1px solid #cbd5e1',
              }}
            >
              <option value="testnet">Testnet</option>
              <option value="mainnet">Mainnet</option>
            </select>
          </div>

          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            <li style={{ marginBottom: 8 }}>
              <NavLink
                to="/keys"
                style={({ isActive }) => ({
                  textDecoration: 'none',
                  color: isActive ? '#2563eb' : '#334155',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                API Keys
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/transactions"
                style={({ isActive }) => ({
                  textDecoration: 'none',
                  color: isActive ? '#2563eb' : '#334155',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                Transactions
              </NavLink>
            </li>
          </ul>
        </nav>

        <main style={{ flex: 1, padding: 32 }}>
          <Routes>
            <Route path="/keys" element={<ApiKeys network={network} />} />
            <Route path="/transactions" element={<Transactions network={network} />} />
            <Route path="*" element={<Navigate to="/keys" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
