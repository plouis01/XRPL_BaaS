// Public landing page — what an unauthenticated visitor sees at `/`.
// The sign-in form is one click away (the `Get started` / `Sign in`
// CTAs route to `/login`). Copy is intentionally short — anyone reading
// past the hero is a developer who'd rather skim docs than marketing.

import { Link } from 'react-router-dom';

const DOCS_URL = import.meta.env.VITE_DOCS_URL ?? 'http://localhost:4321';

export function Landing() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f8fafc',
        fontFamily: 'system-ui, sans-serif',
        color: '#0f172a',
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '20px 48px',
          borderBottom: '1px solid #e2e8f0',
          background: '#fff',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 18 }}>RailForge</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: '#475569',
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            Docs
          </a>
          <Link
            to="/login"
            style={{
              color: '#475569',
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            Sign in
          </Link>
          <Link
            to="/login?mode=signup"
            style={{
              background: '#2563eb',
              color: '#fff',
              padding: '8px 14px',
              borderRadius: 6,
              textDecoration: 'none',
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Get started
          </Link>
        </div>
      </header>

      <main
        style={{
          maxWidth: 980,
          margin: '0 auto',
          padding: '64px 32px',
        }}
      >
        <section style={{ textAlign: 'center', marginBottom: 64 }}>
          <div
            style={{
              display: 'inline-block',
              padding: '4px 10px',
              background: '#dbeafe',
              color: '#1d4ed8',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 16,
              letterSpacing: 0.4,
            }}
          >
            ALPHA · TESTNET
          </div>
          <h1 style={{ fontSize: 44, margin: '0 0 16px', lineHeight: 1.1 }}>
            Payment rails for fintechs and autonomous agents.
          </h1>
          <p
            style={{
              fontSize: 18,
              color: '#475569',
              maxWidth: 680,
              margin: '0 auto 32px',
              lineHeight: 1.5,
            }}
          >
            One REST API for accounts, tokens, payments, and scope-bound agents on XRPL. Mint a
            wallet for an AI agent, cap its daily spend, and revoke it on-chain, all without
            touching xrpl.js, keys, or reserves.
          </p>
          <div
            style={{
              display: 'flex',
              gap: 12,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Link
              to="/login?mode=signup"
              style={{
                background: '#2563eb',
                color: '#fff',
                padding: '12px 22px',
                borderRadius: 8,
                textDecoration: 'none',
                fontSize: 15,
                fontWeight: 500,
              }}
            >
              Create a testnet account
            </Link>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: '#fff',
                color: '#0f172a',
                padding: '12px 22px',
                borderRadius: 8,
                textDecoration: 'none',
                fontSize: 15,
                fontWeight: 500,
                border: '1px solid #cbd5e1',
              }}
            >
              Read the docs
            </a>
          </div>
        </section>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 20,
            marginBottom: 64,
          }}
        >
          <FeatureCard
            title="Agent provisioning"
            body="Mint an API key with its own XRPL wallet, daily spend caps, and an address allowlist."
          />
          <FeatureCard
            title="Spend policies built in"
            body="Per-agent daily limits, op ceilings, and an address allowlist."
          />
          <FeatureCard
            title="Accounts & HSM signing"
            body="Master keys never leave the HSM boundary; users hold a regular key for day-to-day ops."
          />
          <FeatureCard
            title="Payments & webhooks"
            body="Idempotent XRP and token payments, escrow, cross-currency."
          />
          <FeatureCard
            title="MPTs by default"
            body="Issue stablecoins and RWAs as Multi-Purpose Tokens."
          />
          <FeatureCard
            title="Compliance primitives"
            body="On-chain credentials, permissioned domains, permissioned DEX, and delegated permissions."
          />
        </section>

        <section style={{ marginBottom: 64 }}>
          <h2
            style={{
              fontSize: 24,
              margin: '0 0 8px',
              textAlign: 'center',
            }}
          >
            Built for
          </h2>
          <p
            style={{
              color: '#64748b',
              fontSize: 14,
              textAlign: 'center',
              margin: '0 0 32px',
            }}
          >
            Two audiences, one API. Pick the workflow that fits, or combine them.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 20,
            }}
          >
            <AudienceCard
              tag="AUTONOMOUS AGENTS"
              title="Give your agent a wallet, and a leash."
              bullets={[
                'Provision a payment agent with specific rules.',
                'Constraints prevent prompt injection.',
                'Settlement webhooks let the agent react in real time.',
              ]}
            />
            <AudienceCard
              tag="FINTECHS & ISSUERS"
              title="Ship XRPL products without the integration tax."
              bullets={[
                'Issue customisable stablecoins or RWAs.',
                'Cross-currency payments, escrow, and HMAC-signed webhooks.',
                'Compliance primitives.',
              ]}
            />
          </div>
        </section>

        <section
          style={{
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            padding: 32,
            textAlign: 'center',
          }}
        >
          <h2 style={{ fontSize: 22, margin: '0 0 8px' }}>One click from your first transaction</h2>
          <p style={{ color: '#64748b', margin: '0 0 20px', fontSize: 14 }}>
            Sign up to get a testnet key, then send your first payment or spin up your first agent
            in under a minute.
          </p>
          <Link
            to="/login?mode=signup"
            style={{
              display: 'inline-block',
              background: '#2563eb',
              color: '#fff',
              padding: '12px 22px',
              borderRadius: 8,
              textDecoration: 'none',
              fontSize: 15,
              fontWeight: 500,
            }}
          >
            Get started
          </Link>
        </section>
      </main>

      <footer
        style={{
          textAlign: 'center',
          padding: '32px',
          color: '#64748b',
          fontSize: 12,
        }}
      >
        RailForge · A DUSA LABS product
      </footer>
    </div>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        padding: 20,
      }}
    >
      <h3 style={{ fontSize: 15, margin: '0 0 8px', color: '#0f172a' }}>{title}</h3>
      <p style={{ fontSize: 13, color: '#475569', margin: 0, lineHeight: 1.55 }}>{body}</p>
    </div>
  );
}

function AudienceCard({
  tag,
  title,
  bullets,
}: {
  tag: string;
  title: string;
  bullets: string[];
}) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        padding: 28,
      }}
    >
      <div
        style={{
          display: 'inline-block',
          padding: '3px 8px',
          background: '#f1f5f9',
          color: '#475569',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.6,
          marginBottom: 12,
        }}
      >
        {tag}
      </div>
      <h3 style={{ fontSize: 18, margin: '0 0 12px', lineHeight: 1.3 }}>{title}</h3>
      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          color: '#475569',
          fontSize: 13,
          lineHeight: 1.65,
        }}
      >
        {bullets.map((b) => (
          <li key={b} style={{ marginBottom: 6 }}>
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}
