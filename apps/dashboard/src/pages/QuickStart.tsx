// Authed quick-start page. The first thing a freshly-signed-up developer
// should land on after creating an API key. Walks through three concrete
// curl steps (account → payment → webhook) so they ship a tx before
// closing the tab.
//
// We deliberately tell the user to mint the key themselves on the API
// Keys page rather than echoing one back here — minted keys are shown
// once, and showing a key on a route that anyone can navigate back to
// would invite "wait, where did I leave that key open" leaks.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Network } from '../types.ts';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

export function QuickStart({ network }: { network: Network }) {
  return (
    <div style={{ maxWidth: 760 }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 24 }}>Quick start</h1>
      <p style={{ margin: '0 0 32px', color: '#475569', fontSize: 14 }}>
        Three curl commands and you've created an XRPL account, sent a payment, and seen a signed
        webhook.{' '}
        {network === 'testnet'
          ? 'Testnet only.'
          : 'Mainnet version.'}
      </p>

      <Step
        n={1}
        title="Mint an API key"
        body={
          <>
            <p style={{ margin: '0 0 12px', color: '#475569', fontSize: 14 }}>
              Head to{' '}
              <Link to="/keys" style={{ color: '#2563eb' }}>
                API Keys
              </Link>{' '}
              and click <em>Create key</em>. Copy the raw key — <code style={code}>rf_test_…</code>{' '}
              — and export it as a shell variable. The dashboard cannot show it again.
            </p>
            <Snippet text={'export RF_KEY=rf_test_paste_your_key_here'} />
          </>
        }
      />

      <Step
        n={2}
        title="Create your first XRPL account"
        body={
          <>
            <p style={{ margin: '0 0 12px', color: '#475569', fontSize: 14 }}>
              RailForge generates a wallet, holds the master key in HSM, and funds it from the
              testnet faucet. The response includes the XRPL classic address.
            </p>
            <Snippet
              text={`curl -X POST ${API_BASE}/v1/accounts \\
  -H "X-API-Key: $RF_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{"label":"my-first-account"}'`}
            />
          </>
        }
      />

      <Step
        n={3}
        title="Send a payment"
        body={
          <>
            <p style={{ margin: '0 0 12px', color: '#475569', fontSize: 14 }}>
              Submit drops (1 XRP = 1,000,000 drops) from one funded account to any classic address.
              The response gives you a tx id; status flips to <code style={code}>confirmed</code>{' '}
              after the next ledger close.
            </p>
            <Snippet
              text={`curl -X POST ${API_BASE}/v1/payments \\
  -H "X-API-Key: $RF_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "rYourSourceAddressFromStep2",
    "to":   "rDestinationClassicAddress",
    "amount": { "type": "xrp", "value_drops": "10000000" }
  }'`}
            />
          </>
        }
      />

      <Step
        n={4}
        title="Listen for webhooks"
        body={
          <>
            <p style={{ margin: '0 0 12px', color: '#475569', fontSize: 14 }}>
              Register a webhook endpoint and RailForge pushes signed events on every validated tx.
              Verify the
              <code style={code}>X-RailForge-Signature</code> header by HMAC-SHA256 over{' '}
              <code style={code}>timestamp + "." + body</code> using the endpoint secret returned at
              registration.
            </p>
            <Snippet
              text={`curl -X POST ${API_BASE}/v1/webhooks/endpoints \\
  -H "X-API-Key: $RF_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://your-host.example.com/hooks/railforge",
    "events": ["transaction.confirmed", "transaction.failed"]
  }'`}
            />
          </>
        }
      />

      <div
        style={{
          marginTop: 32,
          padding: 20,
          background: '#f1f5f9',
          borderRadius: 10,
          border: '1px solid #e2e8f0',
        }}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>What's next?</h3>
        <ul
          style={{
            margin: 0,
            paddingLeft: 20,
            color: '#475569',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          <li>
            Issue a token →{' '}
            <Link to="/tokens" style={{ color: '#2563eb' }}>
              Tokens
            </Link>{' '}
            (MPT by default, trust line opt-in)
          </li>
          <li>
            Attach KYC credentials →{' '}
            <Link to="/credentials" style={{ color: '#2563eb' }}>
              Credentials
            </Link>{' '}
            (XLS-70, third-party issuer marketplace)
          </li>
          <li>
            Spin up a payment agent →{' '}
            <Link to="/agents" style={{ color: '#2563eb' }}>
              Agents
            </Link>{' '}
            (delegated, scope-bound API keys)
          </li>
          <li>
            Full reference at{' '}
            <a
              href="http://localhost:4321"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#2563eb' }}
            >
              the docs site
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}

const code: React.CSSProperties = {
  background: '#f1f5f9',
  padding: '1px 5px',
  borderRadius: 3,
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 12,
};

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2
        style={{
          margin: '0 0 12px',
          fontSize: 17,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 999,
            background: '#2563eb',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {n}
        </span>
        {title}
      </h2>
      <div style={{ marginLeft: 36 }}>{body}</div>
    </section>
  );
}

function Snippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Insecure origin — let the user select manually.
    }
  };
  return (
    <div style={{ position: 'relative' }}>
      <pre
        style={{
          background: '#0f172a',
          color: '#e2e8f0',
          padding: '14px 16px',
          borderRadius: 8,
          fontSize: 12,
          fontFamily: 'ui-monospace, Menlo, monospace',
          margin: 0,
          overflow: 'auto',
          lineHeight: 1.55,
        }}
      >
        <code>{text}</code>
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: copied ? '#22c55e' : '#1e293b',
          color: '#fff',
          border: '1px solid #334155',
          borderRadius: 4,
          padding: '3px 8px',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
