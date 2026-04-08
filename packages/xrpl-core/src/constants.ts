// Network endpoints, reserve amounts, and other XRPL constants.
// Single source of truth — do NOT inline these in api/worker/indexer.

export const TESTNET_WS_URL = "wss://s.altnet.rippletest.net:51233";
export const TESTNET_NODE_URL = "https://s.altnet.rippletest.net:51234";

// Mainnet URLs are referenced here so the mainnet-block hook can pattern-match,
// but importing them does NOT bypass the hook — the hook checks the bash
// command being run, not the source code.
export const MAINNET_WS_URLS = [
  "wss://s1.ripple.com",
  "wss://s2.ripple.com",
  "wss://xrplcluster.com",
] as const;

// XRPL reserve constants (in XRP). Source: rippled defaults at time of writing.
// Verify against current ledger state if you need exact values.
export const BASE_RESERVE_XRP = 10;
export const OWNER_RESERVE_XRP = 2;

// LastLedgerSequence offset — how far ahead to set tx expiration.
// 20 ledgers ≈ 80 seconds. See CLAUDE.md implementation rules.
export const LAST_LEDGER_OFFSET = 20;

// Default tx fee in drops (12 = 0.000012 XRP).
export const DEFAULT_FEE_DROPS = "12";
