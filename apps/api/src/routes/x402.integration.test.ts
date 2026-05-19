// End-to-end x402 XRP integration test. SPRINT_10_PLAN.md §5, Day 6.
//
// Proves the full protocol loop against real testnet rippled + the real
// DB + the real x402 middleware + the SDK's pay() flow:
//
//   1. Faucet-fund a payer wallet and a treasury wallet.
//   2. Spin up a minimal Hono server (the real createX402Middleware +
//      the real x402DemoRoute handler) on a random local port.
//   3. Call client.x402.pay() with a signer that uses xrpl.js to
//      build → sign → submitAndWait a XRP Payment with the right
//      DestinationTag.
//   4. The SDK retries with the X-PAYMENT header; the middleware's
//      verifyPayment hits real rippled `tx`, matches the delivered
//      amount, and atomically claims the intent.
//   5. The handler returns 200 with the echoed body.
//   6. The DB row in x402_intents has consumed_at + consuming_tx_hash set.
//
// GATING: self-skips unless RAILFORGE_TEST_NETWORK=testnet AND
// DATABASE_URL is set. Reads the gating from the same env flags every
// other integration test uses.
//
// Run with:
//   set -a && source .env && set +a && \
//   RAILFORGE_TEST_NETWORK=testnet \
//   bunx --cwd apps/api vitest run --config vitest.integration.config.ts \
//        src/routes/x402.integration.test.ts

import { createServer, type Server } from "node:http";
import { db, eq, schema } from "@railforge/db";
import { buildXrpPayment } from "@railforge/xrpl-core";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Wallet } from "xrpl";
import { RailForge } from "../../../../packages/sdk/src/index.ts";
import type { X402Signer } from "../../../../packages/sdk/src/types.ts";
import { createX402Middleware } from "../middleware/x402.ts";
import type { AppEnv } from "../types.ts";
import { __setReadClientForTests } from "../xrpl/readClient.ts";
import x402DemoRoute from "./x402Demo.ts";

const SHOULD_RUN =
  process.env.RAILFORGE_TEST_NETWORK === "testnet" &&
  !!process.env.DATABASE_URL;
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

const TESTNET_WS =
  process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";

// Hold on to test fixtures across the suite so cleanup can shut them down.
let payer: Wallet;
let treasury: Wallet;
let xrplClient: Client;
// Node http server. Bun.serve isn't available — vitest spawns Node workers
// even when invoked via `bunx vitest`. We bridge Node's req/res to Hono's
// fetch-style app.fetch(Request) → Response.
let server: Server | null = null;
let serverUrl = "";

async function faucetFund(): Promise<Wallet> {
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`faucet failed: ${res.status}`);
  const body = (await res.json()) as {
    account: { secret?: string };
    seed?: string;
  };
  const seed = body.account.secret ?? body.seed;
  if (!seed) throw new Error("faucet returned no seed");
  return Wallet.fromSeed(seed);
}

async function waitForOnLedger(client: Client, address: string): Promise<void> {
  // Faucets typically return before the funding tx validates. Poll
  // account_info until rippled sees the account or give up after 30s.
  for (let i = 0; i < 15; i++) {
    try {
      await client.request({
        command: "account_info",
        account: address,
        ledger_index: "current",
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`account ${address} never appeared on-ledger after faucet`);
}

describeOrSkip("x402 XRP end-to-end (testnet + real DB + real HTTP)", () => {
  beforeAll(async () => {
    // 1. Faucet two wallets — one payer, one payee (treasury).
    [payer, treasury] = await Promise.all([faucetFund(), faucetFund()]);

    // 2. Connect a single XRPL client to testnet — the signer uses it
    //    for submitAndWait, the test also uses it for the on-ledger
    //    sanity check below.
    // 30s connection timeout — the testnet WS can take a few seconds to
    // accept the first connection from a cold IP.
    xrplClient = new Client(TESTNET_WS, { connectionTimeout: 30_000 });
    await xrplClient.connect();
    await Promise.all([
      waitForOnLedger(xrplClient, payer.classicAddress),
      waitForOnLedger(xrplClient, treasury.classicAddress),
    ]);

    // Wire the same already-connected XRPL client into the verifier's
    // readClient singleton. Avoids a second WebSocket setup (which would
    // hit the verifier's default 5s connectionTimeout on a cold IP) and
    // keeps the test deterministic.
    __setReadClientForTests({
      request: (req) =>
        xrplClient.request(req as Parameters<Client["request"]>[0]),
    });

    // 3. Spin up a minimal Hono app with the real middleware.
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      createX402Middleware({
        // Static quote — Mode A. 10000 drops = 0.01 XRP.
        resolveRoute: async () => ({
          payeeAddress: treasury.classicAddress,
          asset: "XRP",
          amount: "10000",
          clientId: null,
        }),
        intentsPerMinutePerIp: 1000,
      }),
    );
    app.route("/v1/x402-demo", x402DemoRoute);

    // Node http → Hono bridge. Buffers the request body, builds a fetch
    // Request, awaits app.fetch, copies the Response back. Good enough for
    // a single in-process integration test — not a substitute for the
    // production server.
    server = createServer((nodeReq, nodeRes) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
        const bodyBuf = chunks.length ? Buffer.concat(chunks) : null;
        const host =
          nodeReq.headers.host ??
          `localhost:${(server!.address() as { port: number }).port}`;
        const url = `http://${host}${nodeReq.url ?? "/"}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          else if (typeof v === "string") headers.set(k, v);
        }
        const honoReq = new Request(url, {
          method: nodeReq.method,
          headers,
          body: bodyBuf && bodyBuf.length ? bodyBuf : null,
        });
        const honoRes = await app.fetch(honoReq);
        nodeRes.statusCode = honoRes.status;
        honoRes.headers.forEach((v, k) => nodeRes.setHeader(k, v));
        const respBuf = Buffer.from(await honoRes.arrayBuffer());
        nodeRes.end(respBuf);
      })();
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server.listen returned no address");
    serverUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    try {
      if (xrplClient?.isConnected()) await xrplClient.disconnect();
    } catch {}
  });

  it("SDK pay() → 402 → signed Payment → 200 with consumed intent", async () => {
    // Signer uses xrpl.js end-to-end: build → autofill → sign → submitAndWait.
    // submitAndWait blocks until the tx validates (tesSUCCESS) — that's
    // exactly what the verifier requires before it accepts the X-PAYMENT.
    const signer: X402Signer = {
      async signAndSubmit(req) {
        expect(req.payee).toBe(treasury.classicAddress);
        expect(req.asset).toBe("XRP");
        expect(req.amount).toBe("10000");
        expect(req.destinationTag).toBeTypeOf("number");

        const tx = buildXrpPayment({
          account: payer.classicAddress,
          destination: req.payee,
          amountDrops: req.amount,
          destinationTag: req.destinationTag,
        });
        const prepared = await xrplClient.autofill(tx);
        const signed = payer.sign(prepared);
        const result = await xrplClient.submitAndWait(signed.tx_blob);
        // xrpl.js returns the meta nested under .result.meta.
        const meta = result.result.meta;
        const code =
          typeof meta === "object" && meta && "TransactionResult" in meta
            ? (meta as { TransactionResult: string }).TransactionResult
            : null;
        if (code !== "tesSUCCESS") {
          throw new Error(`testnet rejected the payment: ${code}`);
        }
        return { tx_hash: signed.hash };
      },
    };

    // The SDK doesn't authenticate the demo path — payment IS the auth —
    // but the constructor still requires an apiKey. Any value works.
    const sdk = new RailForge({
      apiKey: "rf_test_unused",
      baseUrl: serverUrl,
    });

    const res = await sdk.x402.pay(`${serverUrl}/v1/x402-demo/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ping: "pong" }),
      signer,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      echoed: { ping: string };
      paid: {
        intent_id: string;
        tx_hash: string;
        asset_kind: string;
        amount: string;
      };
    };
    expect(body.echoed).toEqual({ ping: "pong" });
    expect(body.paid.asset_kind).toBe("xrp");
    expect(body.paid.amount).toBe("10000");
    expect(body.paid.intent_id).toMatch(/^x402_intent_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.paid.tx_hash).toMatch(/^[0-9A-F]{64}$/);

    // DB-side proof: the row is consumed and references the tx hash.
    const rows = await db
      .select()
      .from(schema.x402Intents)
      .where(eq(schema.x402Intents.id, body.paid.intent_id))
      .limit(1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.consumedAt).toBeInstanceOf(Date);
    expect(row.consumingTxHash).toBe(body.paid.tx_hash);
    expect(row.payeeAddress).toBe(treasury.classicAddress);
    expect(row.amount).toBe("10000");
    expect(row.assetKind).toBe("xrp");
  }, 120_000);
});
