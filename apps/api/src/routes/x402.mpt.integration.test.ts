// End-to-end x402 MPT integration test. SPRINT_10_PLAN.md §5 + §6, Day 7.
//
// Mirrors x402.integration.test.ts (XRP) but settles in MPT. Validates the
// piece the XRP test doesn't: the verifier's post-`fixMPTDeliveredAmount`
// path that reads `tx.meta.delivered_amount` as
// `{ mpt_issuance_id, value }` and matches both fields.
//
// Fixture flow (all against real testnet rippled):
//
//   1. Faucet three wallets:
//      - issuer:   creates the test MPT issuance + sends the initial mint
//      - payer:    pays the x402 quote
//      - treasury: receives the MPT settlement (the x402 payee)
//   2. Issuer submits MPTokenIssuanceCreate (no auth required) — we read
//      `mpt_issuance_id` from the validated meta as the test's fixture id.
//   3. Payer + treasury each submit MPTokenAuthorize to opt in to receive
//      the issuance (no tfMPTRequireAuth, so it's holder-side self-opt-in).
//   4. Issuer mints to payer with a MPT Payment of 100 units.
//   5. Spin up a Hono server with the real x402 middleware quoting in
//      mpt:<id> for 42 units, payable to treasury.
//   6. Drive client.x402.pay() with a signer that builds + signs an MPT
//      Payment from payer to treasury with the right DestinationTag.
//   7. Verifier accepts the validated tx → middleware atomically claims
//      the intent → handler returns 200.
//   8. Assert DB: assetKind='mpt', assetKey == issuance id, consumed_at set.
//
// GATING: same as the XRP test — RAILFORGE_TEST_NETWORK=testnet +
// DATABASE_URL.
//
// Run with:
//   cd apps/api && \
//   set -a && source ../../.env && set +a && \
//   RAILFORGE_TEST_NETWORK=testnet \
//   bunx vitest run --config vitest.integration.config.ts \
//        src/routes/x402.mpt.integration.test.ts

import { type Server, createServer } from 'node:http';
import { db, eq, schema } from '@railforge/db';
import { buildMptAuthorize, buildMptIssuanceCreate, buildMptPayment } from '@railforge/xrpl-core';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Wallet, decodeAccountID } from 'xrpl';
import { RailForge } from '../../../../packages/sdk/src/index.ts';
import type { X402Signer } from '../../../../packages/sdk/src/types.ts';
import { createX402Middleware } from '../middleware/x402.ts';
import type { AppEnv } from '../types.ts';
import { __setReadClientForTests } from '../xrpl/readClient.ts';
import x402DemoRoute from './x402Demo.ts';

const SHOULD_RUN = process.env.RAILFORGE_TEST_NETWORK === 'testnet' && !!process.env.DATABASE_URL;
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

const TESTNET_WS = process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233';
const FAUCET_URL = 'https://faucet.altnet.rippletest.net/accounts';

let payer: Wallet;
let issuer: Wallet;
let treasury: Wallet;
let xrplClient: Client;
let server: Server | null = null;
let serverUrl = '';
let mptIssuanceId = '';

async function faucetFund(): Promise<Wallet> {
  const res = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`faucet failed: ${res.status}`);
  const body = (await res.json()) as {
    account: { secret?: string };
    seed?: string;
  };
  const seed = body.account.secret ?? body.seed;
  if (!seed) throw new Error('faucet returned no seed');
  return Wallet.fromSeed(seed);
}

async function waitForOnLedger(client: Client, address: string): Promise<void> {
  for (let i = 0; i < 15; i++) {
    try {
      await client.request({
        command: 'account_info',
        account: address,
        ledger_index: 'current',
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`account ${address} never appeared on-ledger after faucet`);
}

/**
 * Helper: autofill + sign + submitAndWait, asserting tesSUCCESS. Returns
 * the validated tx response (which carries `result.meta` we read below).
 */
async function signSubmitWait(
  client: Client,
  wallet: Wallet,
  // biome-ignore lint/suspicious/noExplicitAny: xrpl.js tx union is too noisy
  tx: any,
): Promise<{ hash: string; meta: unknown }> {
  const prepared = await client.autofill(tx);
  // xrpl.js's default LastLedgerSequence window is 20 ledgers (~80s). On
  // testnet under load, submitAndWait's polling has been observed to
  // outrun that window even when the tx validated tesSUCCESS. Bump to
  // 200 ledgers (~13 minutes) — enough headroom that polling never
  // fails the window check.
  prepared.LastLedgerSequence = (prepared.LastLedgerSequence ?? 0) + 180;
  const signed = wallet.sign(prepared);
  let res: { result?: { meta?: unknown; hash?: string } };
  try {
    res = await client.submitAndWait(signed.tx_blob);
  } catch (err) {
    // Defense in depth: even with the bumped window, if submitAndWait
    // throws but rippled actually validated the tx, fetch by hash and
    // accept on tesSUCCESS. The error message includes "tesSUCCESS"
    // when the tx did succeed, so we only retry on that signal.
    if (err instanceof Error && err.message.includes('tesSUCCESS')) {
      res = (await client.request({
        command: 'tx',
        transaction: signed.hash,
        // biome-ignore lint/suspicious/noExplicitAny: rippled tx command type narrows poorly
      } as unknown as any)) as { result?: { meta?: unknown; hash?: string } };
    } else {
      throw err;
    }
  }
  const meta = res?.result?.meta;
  const code =
    typeof meta === 'object' && meta && 'TransactionResult' in meta
      ? (meta as { TransactionResult: string }).TransactionResult
      : null;
  if (code !== 'tesSUCCESS') {
    throw new Error(`testnet rejected ${tx.TransactionType}: ${code}`);
  }
  return { hash: signed.hash, meta };
}

/**
 * Walk a validated tx's meta.AffectedNodes and return the
 * `mpt_issuance_id` from the CreatedNode of LedgerEntryType
 * MPTokenIssuance. Mirrors apps/worker/src/jobs/txConfirmer.ts's
 * extractMptIssuanceIdFromMeta — inlined here to avoid cross-app import.
 */
function extractMptIdFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const nodes = (meta as { AffectedNodes?: unknown[] }).AffectedNodes;
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    const created = (node as { CreatedNode?: Record<string, unknown> }).CreatedNode;
    if (!created || created.LedgerEntryType !== 'MPTokenIssuance') continue;
    const fields = (created.NewFields ?? {}) as Record<string, unknown>;
    for (const c of [fields.mpt_issuance_id, fields.MPTokenIssuanceID]) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
    // Fallback (current rippled + xrpl.js v4.6): derive id from
    // Sequence + Issuer per the spec — 4-byte big-endian Sequence
    // concatenated with the 20-byte issuer account-id (40 hex chars).
    // Mirrors apps/worker/src/jobs/txConfirmer.ts's same derivation.
    const seq = typeof fields.Sequence === 'number' ? fields.Sequence : null;
    const issuer = typeof fields.Issuer === 'string' ? fields.Issuer : null;
    if (seq !== null && issuer !== null) {
      try {
        const accountIdHex = Buffer.from(decodeAccountID(issuer)).toString('hex').toUpperCase();
        if (accountIdHex.length === 40) {
          const seqHex = seq.toString(16).padStart(8, '0').toUpperCase();
          return seqHex + accountIdHex;
        }
      } catch {
        // fall through to null
      }
    }
  }
  return null;
}

describeOrSkip('x402 MPT end-to-end (testnet + real DB + real HTTP)', () => {
  beforeAll(async () => {
    [payer, issuer, treasury] = await Promise.all([faucetFund(), faucetFund(), faucetFund()]);

    xrplClient = new Client(TESTNET_WS, { connectionTimeout: 30_000 });
    await xrplClient.connect();
    await Promise.all([
      waitForOnLedger(xrplClient, payer.classicAddress),
      waitForOnLedger(xrplClient, issuer.classicAddress),
      waitForOnLedger(xrplClient, treasury.classicAddress),
    ]);

    // 1. Issuer creates an MPT issuance with no auth requirement, scale 0,
    // and a generous max supply. The validated tx's meta gives us the
    // canonical 48-hex MPTokenIssuanceID we'll use for the rest of the test.
    // tfMPTCanTransfer (0x20 / 32) is required for holder-to-holder
    // transfers. Without it, only issuer↔holder moves are valid — the
    // payer-to-treasury settlement would fail with tecNO_AUTH. No
    // tfMPTRequireAuth set, so the payer + treasury authorize via
    // holder-side self-opt-in below.
    const TF_MPT_CAN_TRANSFER = 32;
    const createTx = buildMptIssuanceCreate({
      account: issuer.classicAddress,
      assetScale: 0,
      maximumAmount: '1000000',
      flags: TF_MPT_CAN_TRANSFER,
    });
    const createRes = await signSubmitWait(xrplClient, issuer, createTx);
    const id = extractMptIdFromMeta(createRes.meta);
    if (!id) throw new Error('MPT issuance created but no id in meta');
    mptIssuanceId = id;

    // 2. Both payer and treasury must MPTokenAuthorize (holder-side
    // opt-in) before they can receive the MPT. Run sequentially —
    // submitAndWait already serialises by sequence per account.
    await signSubmitWait(
      xrplClient,
      payer,
      buildMptAuthorize({ account: payer.classicAddress, mptIssuanceId }),
    );
    await signSubmitWait(
      xrplClient,
      treasury,
      buildMptAuthorize({ account: treasury.classicAddress, mptIssuanceId }),
    );

    // 3. Issuer mints 100 units to payer so the payer has something to pay
    // the x402 quote with.
    await signSubmitWait(
      xrplClient,
      issuer,
      buildMptPayment({
        account: issuer.classicAddress,
        destination: payer.classicAddress,
        mptIssuanceId,
        value: '100',
      }),
    );

    // Wire the test's connected XRPL client into the verifier's
    // readClient singleton (same trick as the XRP test) — avoids
    // a second WS handshake during verification.
    __setReadClientForTests({
      request: (req) => xrplClient.request(req as Parameters<Client['request']>[0]),
    });

    // 4. Spin up the API surface. Static MPT quote — Mode A.
    const app = new Hono<AppEnv>();
    app.use(
      '*',
      createX402Middleware({
        resolveRoute: async () => ({
          payeeAddress: treasury.classicAddress,
          asset: `mpt:${mptIssuanceId}`,
          amount: '42',
          clientId: null,
        }),
        intentsPerMinutePerIp: 1000,
      }),
    );
    app.route('/v1/x402-demo', x402DemoRoute);

    server = createServer((nodeReq, nodeRes) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
        const bodyBuf = chunks.length ? Buffer.concat(chunks) : null;
        const host =
          nodeReq.headers.host ?? `localhost:${(server!.address() as { port: number }).port}`;
        const url = `http://${host}${nodeReq.url ?? '/'}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          else if (typeof v === 'string') headers.set(k, v);
        }
        const honoReq = new Request(url, {
          method: nodeReq.method,
          headers,
          body: bodyBuf?.length ? bodyBuf : null,
        });
        const honoRes = await app.fetch(honoReq);
        nodeRes.statusCode = honoRes.status;
        honoRes.headers.forEach((v, k) => nodeRes.setHeader(k, v));
        const respBuf = Buffer.from(await honoRes.arrayBuffer());
        nodeRes.end(respBuf);
      })();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('server.listen returned no address');
    serverUrl = `http://127.0.0.1:${address.port}`;
  }, 180_000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    try {
      if (xrplClient?.isConnected()) await xrplClient.disconnect();
    } catch {}
  });

  it('SDK pay() → 402 → signed MPT Payment → 200 with consumed intent', async () => {
    const signer: X402Signer = {
      async signAndSubmit(req) {
        expect(req.payee).toBe(treasury.classicAddress);
        expect(req.asset).toBe(`mpt:${mptIssuanceId}`);
        expect(req.amount).toBe('42');
        expect(req.destinationTag).toBeTypeOf('number');

        const tx = buildMptPayment({
          account: payer.classicAddress,
          destination: req.payee,
          mptIssuanceId,
          value: req.amount,
          destinationTag: req.destinationTag,
        });
        const r = await signSubmitWait(xrplClient, payer, tx);
        return { tx_hash: r.hash };
      },
    };

    const sdk = new RailForge({ apiKey: 'rf_test_unused', baseUrl: serverUrl });

    const res = await sdk.x402.pay(`${serverUrl}/v1/x402-demo/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mpt' }),
      signer,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      echoed: { kind: string };
      paid: {
        intent_id: string;
        tx_hash: string;
        asset_kind: string;
        amount: string;
      };
    };
    expect(body.echoed).toEqual({ kind: 'mpt' });
    expect(body.paid.asset_kind).toBe('mpt');
    expect(body.paid.amount).toBe('42');
    expect(body.paid.intent_id).toMatch(/^x402_intent_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.paid.tx_hash).toMatch(/^[0-9A-F]{64}$/);

    // DB-side proof of the MPT-specific fields.
    const rows = await db
      .select()
      .from(schema.x402Intents)
      .where(eq(schema.x402Intents.id, body.paid.intent_id))
      .limit(1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.consumedAt).toBeInstanceOf(Date);
    expect(row.consumingTxHash).toBe(body.paid.tx_hash);
    expect(row.assetKind).toBe('mpt');
    expect(row.assetKey).toBe(mptIssuanceId.toUpperCase());
    expect(row.amount).toBe('42');
    expect(row.payeeAddress).toBe(treasury.classicAddress);
  }, 180_000);
});
