import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError, api, logout as apiLogout } from './api.ts';
import { Agents } from './pages/Agents.tsx';
import { ApiKeys } from './pages/ApiKeys.tsx';
import { Credentials } from './pages/Credentials.tsx';
import { Domains } from './pages/Domains.tsx';
import { Landing } from './pages/Landing.tsx';
import { LoginForm } from './pages/LoginForm.tsx';
import { QuickStart } from './pages/QuickStart.tsx';
import { Tokens } from './pages/Tokens.tsx';
import { Transactions } from './pages/Transactions.tsx';
import type { Network } from './types.ts';

type AuthState = 'checking' | 'anon' | 'authed';

export function App() {
  const [network, setNetwork] = useState<Network>('testnet');
  const [authState, setAuthState] = useState<AuthState>('checking');

  // Ping a cheap authenticated endpoint to decide whether the session
  // cookie is valid. 401 means no/expired cookie → show login.
  const checkAuth = useCallback(async () => {
    try {
      await api<{ data: unknown[] }>('/v1/dashboard/keys?environment=testnet');
      setAuthState('authed');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuthState('anon');
      } else {
        // Network error (API down, CORS, etc.) — treat as anon so the
        // user sees the login form instead of a blank screen.
        setAuthState('anon');
      }
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  const handleLogout = async () => {
    await apiLogout();
    setAuthState('anon');
  };

  if (authState === 'checking') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#64748b',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        Loading...
      </div>
    );
  }

  if (authState === 'anon') {
    // Anon flow has its own router so a visitor can land on `/`
    // (Landing) and click through to `/login` without the authed
    // sidebar mounting. Any other path bounces back to the landing.
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<LoginForm onLoggedIn={() => setAuthState('authed')} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    );
  }

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
            display: 'flex',
            flexDirection: 'column',
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

          <ul style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1 }}>
            <li style={{ marginBottom: 8 }}>
              <NavLink
                to="/quickstart"
                style={({ isActive }) => ({
                  textDecoration: 'none',
                  color: isActive ? '#2563eb' : '#334155',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                Quick start
              </NavLink>
            </li>
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
            <li style={{ marginBottom: 8 }}>
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
            <li style={{ marginBottom: 8 }}>
              <NavLink
                to="/tokens"
                style={({ isActive }) => ({
                  textDecoration: 'none',
                  color: isActive ? '#2563eb' : '#334155',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                Tokens
              </NavLink>
            </li>
            <li style={{ marginBottom: 8 }}>
              <NavLink
                to="/credentials"
                style={({ isActive }) => ({
                  textDecoration: 'none',
                  color: isActive ? '#2563eb' : '#334155',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                Credentials
              </NavLink>
            </li>
            <li style={{ marginBottom: 8 }}>
              <NavLink
                to="/domains"
                style={({ isActive }) => ({
                  textDecoration: 'none',
                  color: isActive ? '#2563eb' : '#334155',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                Domains
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/agents"
                style={({ isActive }) => ({
                  textDecoration: 'none',
                  color: isActive ? '#2563eb' : '#334155',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                Agents
              </NavLink>
            </li>
          </ul>

          <a
            href="http://localhost:4321"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              marginTop: 16,
              padding: '6px 10px',
              background: 'transparent',
              color: '#64748b',
              border: '1px solid #cbd5e1',
              borderRadius: 4,
              fontSize: 13,
              textAlign: 'center',
              textDecoration: 'none',
              display: 'block',
            }}
          >
            Documentation
          </a>

          <button
            type="button"
            onClick={() => void handleLogout()}
            style={{
              marginTop: 8,
              padding: '6px 10px',
              background: 'transparent',
              color: '#64748b',
              border: '1px solid #cbd5e1',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Log out
          </button>
        </nav>

        <main style={{ flex: 1, padding: 32 }}>
          <Routes>
            <Route path="/quickstart" element={<QuickStart network={network} />} />
            <Route path="/keys" element={<ApiKeys network={network} />} />
            <Route path="/transactions" element={<Transactions network={network} />} />
            <Route path="/tokens" element={<Tokens network={network} />} />
            <Route path="/credentials" element={<Credentials network={network} />} />
            <Route path="/domains" element={<Domains network={network} />} />
            <Route path="/agents" element={<Agents network={network} />} />
            {/* Default to /quickstart so a freshly-signed-up developer
                lands on actionable first-tx steps, not an empty key list. */}
            <Route path="*" element={<Navigate to="/quickstart" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
