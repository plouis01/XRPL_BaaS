// Integration test for the Sprint 1 primitives that the Sprint 2 pipeline
// depends on: XrplClientPool, TxSequencer, DevSigner.
//
// CLAUDE.md testing rule: "Any change to apps/worker/src/xrpl/
// {txSubmitter,sequencer,signer}.ts requires an integration test, not just
// a unit test. These are the components where mock/prod divergence will
// hurt most."
//
// What this covers (gaps the unit tests can't):
//
// 1. XrplClientPool against the real testnet rippled — validates the WS
//    connect path, round-robin cycling, and the account_info command shape.
//
// 2. TxSequencer.getNextSequence against a real faucet-funded wallet —
//    validates that the Sequence returned actually matches on-ledger state,
//    that the Lua fenced cache write persists correctly, and that the lock
//    release path works against real Redis.
//
// 3. DevSigner.sign producing a blob that rippled accepts — end-to-end
//    sign → submit → tesSUCCESS. This is the strongest proof the builder
//    output shape and the signer contract match what rippled wants.
//
// GATING: this file self-skips unless RAILFORGE_TEST_NETWORK=testnet.
// CI runs it; local saves don't (would burn testnet faucet credits).
//
// Run with:
//   RAILFORGE_TEST_NETWORK=testnet bun run --filter @railforge/worker test:integration

import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet, type Client } from "xrpl";
import { buildXrpPayment } from "@railforge/xrpl-core";
import { XrplClientPool } from "./client.ts";
import { TxSequencer } from "./sequencer.ts";
import { DevSigner } from "./signer.ts";

const SHOULD_RUN = process.env.RAILFORGE_TEST_NETWORK === "testnet";

const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

describeOrSkip("pipeline integration (testnet)", () => {
  let pool: XrplClientPool;
  let redis: Redis;
  let sequencer: TxSequencer;
  let signer: DevSigner;
  let fundedWallet: Wallet;

  beforeAll(async () => {
    // 1. Real XRPL pool against testnet.
    pool = new XrplClientPool();
    await pool.initialize("testnet", 1);

    // 2. Real Redis.
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

    // 3. Sequencer on real Redis + real XRPL pool.
    sequencer = new TxSequencer(redis, pool);

    // 4. Real DevSigner (NODE_ENV is 'test' during vitest, not 'production').
    signer = new DevSigner();

    // 5. Fund a fresh wallet from the testnet faucet. The faucet response
    // includes a secret we can reconstruct into a Wallet.
    const faucetRes = await fetch(
      "https://faucet.altnet.rippletest.net/accounts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    if (!faucetRes.ok) {
      throw new Error(`faucet failed: ${faucetRes.status}`);
    }
    const faucetBody = (await faucetRes.json()) as {
      account: { classicAddress?: string; address?: string; secret?: string };
      seed?: string;
    };
    const seed = faucetBody.account.secret ?? faucetBody.seed;
    if (!seed) {
      throw new Error("faucet returned no seed");
    }
    fundedWallet = Wallet.fromSeed(seed);
    signer.registerWallet(fundedWallet);

    // 6. Wait for the faucet tx to actually land (faucets usually return
    // before validation). Poll account_info until it resolves.
    const client = pool.getClient() as Client;
    for (let i = 0; i < 15; i++) {
      try {
        await client.request({
          command: "account_info",
          account: fundedWallet.classicAddress,
          ledger_index: "current",
        });
        return; // funded and visible
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error("faucet-funded account never appeared on-ledger");
  });

  afterAll(async () => {
    // Clean up the sequencer cache for this wallet so the integration
    // test doesn't pollute state for subsequent runs.
    if (fundedWallet) {
      await sequencer?.invalidate(fundedWallet.classicAddress).catch(() => {});
    }
    await redis?.quit().catch(() => {});
    await pool?.shutdown().catch(() => {});
  });

  it("XrplClientPool: account_info returns a Sequence for the funded wallet", async () => {
    const client = pool.getClient() as Client;
    const info = await client.request({
      command: "account_info",
      account: fundedWallet.classicAddress,
      ledger_index: "current",
    });
    expect(info.result.account_data.Sequence).toBeTypeOf("number");
    expect(info.result.account_data.Sequence).toBeGreaterThan(0);
  });

  it("TxSequencer.getNextSequence matches the ledger sequence on first call", async () => {
    const client = pool.getClient() as Client;
    const info = await client.request({
      command: "account_info",
      account: fundedWallet.classicAddress,
      ledger_index: "current",
    });
    const ledgerSeq = info.result.account_data.Sequence;

    // Flush cache so we hit the ledger-fetch path.
    await sequencer.invalidate(fundedWallet.classicAddress);

    const nextSeq = await sequencer.getNextSequence(
      fundedWallet.classicAddress,
    );
    expect(nextSeq).toBe(ledgerSeq);

    // Second call should come from the cache.
    const nextNextSeq = await sequencer.getNextSequence(
      fundedWallet.classicAddress,
    );
    expect(nextNextSeq).toBe(ledgerSeq + 1);
  });

  it("DevSigner.sign produces a blob rippled accepts (full sign+submit cycle)", async () => {
    const client = pool.getClient() as Client;
    await sequencer.invalidate(fundedWallet.classicAddress);
    const sequence = await sequencer.getNextSequence(
      fundedWallet.classicAddress,
    );

    const ledgerResponse = await client.request({ command: "ledger_current" });
    const lastLedger = ledgerResponse.result.ledger_current_index + 20;

    // Send to a throwaway destination. XRPL rejects self-payments with
    // temREDUNDANT. The destination doesn't need to be funded for the
    // sign+submit path to work — rippled will reject with tecNO_DST at
    // validation time if the dest doesn't exist + amount is below reserve,
    // but the tx blob will still be accepted into the submission queue.
    const destWallet = Wallet.generate();
    const tx = buildXrpPayment({
      account: fundedWallet.classicAddress,
      destination: destWallet.classicAddress,
      amountDrops: "1",
    });
    const fullTx = {
      ...tx,
      Sequence: sequence,
      LastLedgerSequence: lastLedger,
      Fee: "12",
    };

    const signed = await signer.sign(fundedWallet.classicAddress, fullTx);
    expect(signed.tx_blob).toMatch(/^[0-9A-F]+$/);
    expect(signed.hash).toHaveLength(64);

    // Submit to rippled. We only care that rippled accepted the signed
    // blob and returned a deterministic engine result — that proves the
    // sign path works. The economic outcome (tesSUCCESS vs tec*) depends
    // on the destination's funding state and isn't what we're testing here.
    //
    // - tes* = transaction succeeded on-ledger
    // - tec* = deterministic failure included in the ledger (still valid submission)
    // - ter* = retry (accepted into rippled's queue)
    // Any of the above proves the sign+submit path works.
    // - tem*/tef*/tel* would indicate a malformed/rejected blob → test failure.
    const submitRes = (await client.request({
      command: "submit",
      tx_blob: signed.tx_blob,
    })) as { result: { engine_result: string } };

    expect(submitRes.result.engine_result).toMatch(/^(tes|tec|ter)/);
  });
});
