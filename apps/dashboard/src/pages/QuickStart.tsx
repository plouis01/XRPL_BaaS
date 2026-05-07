// Authed quick-start page. The first thing a freshly-signed-up developer
// should land on after creating their first key.
//
// The shape of the realistic onboarding flow drives this page:
//   - The parent account is auto-created at signup (see
//     apps/api/src/routes/dashboardSignup.ts) and surfaced in the post-
//     signup banner + the Accounts page. No curl needed for that.
//   - Step 1 (dashboard): provision the agent. The Agents page now
//     auto-mints a scope-bound API key as part of the New-agent flow
//     and surfaces it in the one-time success banner — no separate
//     trip to /keys required for the common case.
//   - Step 2 (curl): the tx the agent itself runs. This is the snippet
//     the developer pastes into their agent code — the only curl that
//     survives past onboarding.
//   - Step 3 (curl): backend webhook subscription, also developer code.
//
// A collapsible "Provisioning agents from code" section preserves the
// fully-scripted flow for multi-tenant platforms that mint an agent
// per end-user — that's a real audience but a narrower one.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Network } from '../types.ts';

// API_BASE here is for display in the curl examples below (devs paste
// these into their terminal, so a relative URL would be useless). The
// dashboard's own fetches use relative URLs via the same-origin Worker
// proxy — see apps/dashboard/src/api.ts and apps/dashboard/worker/index.ts.
// Hardcoded to the production Fly host; update if a custom domain lands.
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : 'https://railforge-api.fly.dev';
const DOCS_URL = import.meta.env.VITE_DOCS_URL ?? 'http://localhost:4321';

export function QuickStart({ network }: { network: Network }) {
  return (
    <div style={{ maxWidth: 760 }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 24 }}>Quick start</h1>
      <p style={{ margin: '0 0 32px', color: '#475569', fontSize: 14 }}>
        Three steps to put an autonomous payment agent on XRPL. One click in this dashboard, two
        short shell snippets, both for the agent's own code, not yours. Your parent account was
        auto-created at signup — find its address on the Accounts page.{' '}
        {network === 'testnet'
          ? 'Testnet only, no real value moves.'
          : 'Mainnet, real funds will move.'}
      </p>

      <Step
        n={1}
        title="Provision the agent"
        kind="dashboard"
        body={
          <>
            <p style={{ margin: '0 0 12px', color: '#475569', fontSize: 14 }}>
              On the{' '}
              <Link to="/agents" style={{ color: '#2563eb' }}>
                Agents
              </Link>{' '}
              page, click <strong>New agent</strong>. Pick the{' '}
              <code style={code}>payment-agent</code> preset, set the parent address (auto-created
              at signup, visible on the Accounts page), set a daily spend cap, and add destination
              addresses to the allowlist. Those constraints are enforced server-side <em>before</em>{' '}
              the tx is built, no prompt-injected agent can override them.
            </p>
            <p style={{ margin: '0 0 12px', color: '#475569', fontSize: 14 }}>
              On success the dashboard shows a one-time banner with the agent's{' '}
              <strong>scope-bound API key</strong> already minted. Copy it, that's what step 2
              needs.
            </p>
            <DashboardCTA to="/agents" label="Open Agents →" />
          </>
        }
      />

      <Step
        n={2}
        title="Hand the key to your agent code"
        kind="shell"
        body={
          <>
            <p style={{ margin: '0 0 12px', color: '#475569', fontSize: 14 }}>
              Paste the agent's key into your agent's environment. From here on the agent calls{' '}
              <code style={code}>/v1/payments</code> directly. A non-allowlisted destination or an
              over-cap amount comes back as <code style={code}>403</code> before the tx is ever
              signed.
            </p>
            <Snippet
              text={`export RF_AGENT_KEY=rf_${network === 'mainnet' ? 'live' : 'test'}_paste_agent_key

# What your agent's code does on each payment:
curl -X POST ${API_BASE}/v1/payments \\
  -H "X-API-Key: $RF_AGENT_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from":   "rYourParentAddress",
    "to":     "rAllowlistedDestination",
    "amount": { "type": "xrp", "value_drops": "1000000" }
  }'`}
            />
          </>
        }
      />

      <Step
        n={3}
        title="Subscribe your backend to webhooks"
        kind="shell"
        body={
          <>
            <p style={{ margin: '0 0 12px', color: '#475569', fontSize: 14 }}>
              Register a webhook so your backend gets notified when the agent's tx settles. Verify
              the <code style={code}>X-RailForge-Signature</code> header by HMAC-SHA256 over{' '}
              <code style={code}>timestamp + "." + body</code> using the endpoint secret returned at
              registration. Use your tenant key here, not the scope-bound agent key from step 2.
            </p>
            <Snippet
              text={`# Use the tenant key from signup (scope-bound agent keys can't register webhooks):
export RF_KEY=rf_${network === 'mainnet' ? 'live' : 'test'}_paste_your_tenant_key

curl -X POST ${API_BASE}/v1/webhooks/endpoints \\
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

      <details
        style={{
          marginTop: 8,
          marginBottom: 32,
          padding: 20,
          background: '#fff',
          border: '1px solid #e2e8f0',
          borderRadius: 10,
        }}
      >
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 600,
            color: '#0f172a',
          }}
        >
          Provisioning agents from code
        </summary>
        <p style={{ margin: '12px 0', color: '#475569', fontSize: 13 }}>
          For multi-tenant platforms that mint a fresh agent per end-user, step 1 is also a REST
          endpoint. The whole flow becomes one script:
        </p>
        <Snippet
          text={`# 1. Provision the agent.
curl -X POST ${API_BASE}/v1/agents \\
  -H "X-API-Key: $RF_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "preset": "payment-agent",
    "parent_address": "'$PARENT'",
    "label": "tenant-42-bot",
    "spend_policy": { "daily_limit_usd_cents": "10000" },
    "allowlist": [
      { "entry_type": "destination", "entry_value": "'$DEST'" }
    ]
  }'

# 2. Mint a scope-bound API key for the new agent.
export AGENT_ID=ag_returned_id
curl -X POST ${API_BASE}/v1/dashboard/keys \\
  -H "X-API-Key: $RF_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{"environment":"${network}","agent_id":"'$AGENT_ID'"}'`}
        />
      </details>

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
            Manage agents →{' '}
            <Link to="/agents" style={{ color: '#2563eb' }}>
              Agents
            </Link>{' '}
            — edit allowlists, raise/lower spend caps, revoke on-chain
          </li>
          <li>
            Audit agent activity →{' '}
            <Link to="/transactions" style={{ color: '#2563eb' }}>
              Transactions
            </Link>{' '}
            — every tx is tagged with the agent that signed it
          </li>
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
            Full reference at{' '}
            <a
              href={DOCS_URL}
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
  kind,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
  // `dashboard` steps are click-throughs (no curl). `shell` steps run on
  // the developer's machine or the agent's runtime. The badge color makes
  // the distinction obvious at a glance so a reader knows whether to
  // click or open a terminal.
  kind: 'dashboard' | 'shell';
}) {
  const badge = kind === 'dashboard' ? 'IN DASHBOARD' : 'IN YOUR SHELL';
  const badgeBg = kind === 'dashboard' ? '#ecfdf5' : '#f1f5f9';
  const badgeFg = kind === 'dashboard' ? '#065f46' : '#475569';
  return (
    <section style={{ marginBottom: 28 }}>
      <h2
        style={{
          margin: '0 0 12px',
          fontSize: 17,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
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
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.5,
            background: badgeBg,
            color: badgeFg,
            padding: '2px 7px',
            borderRadius: 4,
          }}
        >
          {badge}
        </span>
      </h2>
      <div style={{ marginLeft: 36 }}>{body}</div>
    </section>
  );
}

function DashboardCTA({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      style={{
        display: 'inline-block',
        background: '#2563eb',
        color: '#fff',
        padding: '8px 14px',
        borderRadius: 6,
        textDecoration: 'none',
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      {label}
    </Link>
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
